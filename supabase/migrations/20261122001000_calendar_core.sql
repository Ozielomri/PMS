-- Step 2 / CAL-01 … CAL-08, CAL-11 … CAL-15: the calendar engine.
-- Design and interpretation calls: docs/plans/step-2-calendar.md. Interface with Properties:
-- docs/plans/step-2-3-contract.md.
--
--   * calendar_days    one row per root listing (single, multi_parent) per night: overrides only.
--                      Effective price/rules are derived at read time from the listing, so listing
--                      edits show on every future night (and every sub-unit) the moment they commit.
--   * calendar_holds   every cause that makes nights unavailable (reservation, quote, owner stay,
--                      manual block, iCal). Exclusive holds can never overlap on a unit
--                      (exclusion constraint); writers also lock the root's night rows.
--   * calendar_changes per-night change log (CAL-13), stored as ranges of equal changes.
--   * one calendar.updated event per listing per transaction (CAL-14), via a deferred trigger.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.calendar_days (
  listing_id uuid not null,
  account_id uuid not null,
  night date not null,
  -- Overrides; null / false = the listing default applies (CAL-04, CAL-06).
  price_override_cents integer check (price_override_cents is null or price_override_cents between 0 and 100000000),
  min_nights_override integer check (min_nights_override is null or min_nights_override between 1 and 365),
  max_nights_override integer check (max_nights_override is null or max_nights_override between 1 and 365),
  closed_to_arrival boolean not null default false,
  closed_to_departure boolean not null default false,
  closed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (listing_id, night),
  foreign key (listing_id, account_id) references public.listings (id, account_id)
);

comment on table public.calendar_days is
  'CAL-01: one row per root listing per night (overrides only; effective values derived). Also the lock target for availability writes.';

create table public.calendar_holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  -- The unit whose nights are held (a sub-unit for multi-unit bookings).
  listing_id uuid not null,
  -- The listing the caller asked for (the multi-unit parent when a sub-unit was auto-assigned).
  requested_listing_id uuid not null,
  check_in date not null,
  check_out date not null,
  nights daterange generated always as (daterange(check_in, check_out, '[)')) stored,
  source_type text not null check (source_type in ('reservation', 'quote', 'owner_stay', 'manual_block', 'ical')),
  source_id uuid,
  exclusive boolean generated always as (source_type in ('reservation', 'quote', 'owner_stay')) stored,
  status text not null default 'active' check (status in ('active', 'released', 'expired')),
  expires_at timestamptz,
  block_reason text check (block_reason is null or block_reason in ('maintenance', 'personal_use', 'other')),
  note text check (note is null or length(note) <= 1000),
  split_from uuid references public.calendar_holds (id),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text check (release_reason is null or length(release_reason) <= 500),
  constraint calendar_holds_dates check (check_out > check_in and check_out - check_in <= 1100),
  constraint calendar_holds_manual_reason check ((source_type = 'manual_block') = (block_reason is not null)),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  foreign key (requested_listing_id, account_id) references public.listings (id, account_id),
  -- CAL-03: never double-book, whatever code path writes the row.
  constraint calendar_holds_no_overlap exclude using gist (listing_id with =, nights with &&)
    where (exclusive and status = 'active')
);

comment on table public.calendar_holds is
  'CAL-03/07: causes of unavailable nights. Exclusive holds (reservation, quote, owner_stay) never overlap on a unit. Never deleted; status active -> released | expired.';

create index calendar_holds_active_idx on public.calendar_holds using gist (listing_id, nights) where status = 'active';
create index calendar_holds_source_idx on public.calendar_holds (source_type, source_id) where source_id is not null;
create unique index calendar_holds_one_active_per_source on public.calendar_holds (source_type, source_id)
  where status = 'active' and exclusive and source_id is not null;
create index calendar_holds_account_idx on public.calendar_holds (account_id, created_at desc);

create table public.calendar_changes (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  listing_id uuid not null,
  nights daterange not null,
  field text not null check (field in ('price', 'min_nights', 'max_nights', 'closed_to_arrival', 'closed_to_departure', 'closed', 'availability')),
  old_value jsonb,
  new_value jsonb,
  source text not null check (source in ('user', 'automation', 'channel', 'pricing_tool', 'api', 'system')),
  actor_type text not null,
  actor_id text,
  actor_user_id uuid,
  hold_id uuid,
  ip inet,
  request_id text,
  occurred_at timestamptz not null default now(),
  txid bigint not null default txid_current()
);

comment on table public.calendar_changes is
  'CAL-13: per-night change log (field, old, new, source, actor). Consecutive nights with the same change share one range row. Append-only.';

create index calendar_changes_listing_idx on public.calendar_changes using gist (listing_id, nights);
create index calendar_changes_account_time_idx on public.calendar_changes (account_id, occurred_at desc, id desc);

-- CAL-15: bearer tokens for external dynamic-pricing tools. The hash lives in `private`, so no
-- client role can ever read it.
create table public.calendar_api_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  name text not null check (length(btrim(name)) between 1 and 100),
  token_hint text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table private.calendar_api_token_hashes (
  token_id uuid primary key references public.calendar_api_tokens (id),
  token_hash text not null unique
);
alter table private.calendar_api_token_hashes enable row level security;

-- CAL-14 scratch: one row per (transaction, listing), flushed into a calendar.updated event at commit.
create table private.calendar_pending_events (
  txid bigint not null default txid_current(),
  listing_id uuid not null,
  account_id uuid not null,
  date_from date not null,
  date_to date not null,
  changes text[] not null,
  primary key (txid, listing_id)
);
alter table private.calendar_pending_events enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Service role (workers, channel sync, API) or a direct database connection: no end user.
create or replace function private.calendar_is_system()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is null and coalesce(private.request_role(), 'service_role') = 'service_role'
$$;

-- RLS helper: may the current user see this listing's calendar?
create or replace function private.can_view_listing_calendar(p_account_id uuid, p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission(p_account_id, 'calendar.view')
     and exists (
       select 1 from public.listings l
       where l.id = p_listing_id and l.account_id = p_account_id
         and private.can_access_listing(l.account_id, l.id, private.listing_scope_tags(l))
     )
$$;

-- Loads the listing and checks the caller may act on it with this permission (system callers may).
create or replace function private.calendar_authorize(p_listing_id uuid, p_permission text)
returns public.listings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.listings;
begin
  select * into v from public.listings where id = p_listing_id;
  if not found then
    raise exception 'listing_not_found: %', p_listing_id using errcode = 'P0002';
  end if;
  if private.calendar_is_system() then
    return v;
  end if;
  if auth.uid() is null
     or not private.has_permission(v.account_id, p_permission)
     or not private.can_access_listing(v.account_id, v.id, private.listing_scope_tags(v)) then
    raise exception 'forbidden: % on listing %', p_permission, p_listing_id using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Permission a user needs to place / change a hold of this type. Reservation-type holds are only
-- reachable through the Reservations module's own RPCs, which check more than this.
create or replace function private.hold_permission(p_source_type text, p_action text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_source_type = 'manual_block' then 'calendar.block'
    when p_source_type = 'ical' then 'calendar.manage'
    when p_action = 'place' then 'reservations.create'
    else 'reservations.edit'
  end
$$;

-- The listing whose prices and rules apply (the parent for a sub-unit).
create or replace function private.rules_listing(p_listing public.listings)
returns public.listings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.listings;
begin
  if p_listing.type = 'sub_unit' then
    select * into v from public.listings where id = p_listing.parent_id;
    return v;
  end if;
  return p_listing;
end;
$$;

create or replace function private.listing_night_price(p_base integer, p_weekend integer, p_weekend_nights smallint[], p_night date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_weekend is not null and extract(dow from p_night)::smallint = any (p_weekend_nights) then p_weekend
    else p_base
  end
$$;

create or replace function private.listing_night_price_source(p_weekend integer, p_weekend_nights smallint[], p_night date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_weekend is not null and extract(dow from p_night)::smallint = any (p_weekend_nights) then 'weekend'
    else 'base'
  end
$$;

-- Last night kept generated (exclusive end): today + max(730, booking window) in the listing timezone.
create or replace function private.calendar_horizon_end(p_listing public.listings)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone p_listing.timezone)::date + greatest(730, p_listing.booking_window_days) + 1
$$;

-- CAL-13 source: users → 'user'; service-role callers may name the source ('pricing_tool', …)
-- with the `pms.calendar_source` setting or the `x-pms-calendar-source` header.
create or replace function private.calendar_source()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_actor record;
  v_source text;
begin
  select * into v_actor from private.current_actor();
  if v_actor.actor_type = 'user' then
    return 'user';
  end if;
  if coalesce(private.request_role(), 'service_role') = 'service_role' then
    v_source := coalesce(
      nullif(current_setting('pms.calendar_source', true), ''),
      nullif(private.request_headers() ->> 'x-pms-calendar-source', '')
    );
    if v_source in ('automation', 'channel', 'pricing_tool', 'api', 'system') then
      return v_source;
    end if;
  end if;
  return case v_actor.actor_type when 'automation' then 'automation' when 'channel' then 'channel' when 'api' then 'api' else 'system' end;
end;
$$;

create or replace function private.log_calendar_change(
  p_account_id uuid,
  p_listing_id uuid,
  p_nights daterange,
  p_field text,
  p_old jsonb,
  p_new jsonb,
  p_hold_id uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.calendar_changes (account_id, listing_id, nights, field, old_value, new_value, source,
                                       actor_type, actor_id, actor_user_id, hold_id, ip, request_id)
  select p_account_id, p_listing_id, p_nights, p_field, p_old, p_new, private.calendar_source(),
         a.actor_type, a.actor_id, a.user_id, p_hold_id, private.current_ip(), private.current_request_id()
  from private.current_actor() a
$$;

-- CAL-14: remember that this listing changed in this transaction; merged per listing.
create or replace function private.queue_calendar_event(p_account_id uuid, p_listing_id uuid, p_from date, p_to date, p_changes text[])
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.calendar_pending_events as p (account_id, listing_id, date_from, date_to, changes)
  values (p_account_id, p_listing_id, p_from, p_to, array(select distinct c from unnest(p_changes) c order by c))
  on conflict (txid, listing_id) do update
    set date_from = least(p.date_from, excluded.date_from),
        date_to = greatest(p.date_to, excluded.date_to),
        changes = array(select distinct c from unnest(p.changes || excluded.changes) c order by c)
$$;

-- Queues the event for the listing and the listings whose calendar it changes with it: a
-- sub-unit's parent (allotment), a parent's sub-units (shared prices, rules and parent blocks).
create or replace function private.note_calendar_change(p_listing_id uuid, p_from date, p_to date, p_changes text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.listings;
begin
  select * into v from public.listings where id = p_listing_id;
  if not found or p_to <= p_from then
    return;
  end if;
  perform private.queue_calendar_event(v.account_id, v.id, p_from, p_to, p_changes);
  if v.type = 'sub_unit' then
    perform private.queue_calendar_event(v.account_id, v.parent_id, p_from, p_to, p_changes);
  elsif v.type = 'multi_parent' then
    perform private.queue_calendar_event(c.account_id, c.id, p_from, p_to, p_changes)
    from public.listings c where c.parent_id = v.id;
  end if;
end;
$$;

create or replace function private.flush_calendar_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v private.calendar_pending_events;
begin
  delete from private.calendar_pending_events
  where txid = new.txid and listing_id = new.listing_id
  returning * into v;
  if found then
    perform private.emit_event(v.account_id, 'calendar.updated', 'listing', v.listing_id::text,
      jsonb_build_object('listing_id', v.listing_id, 'date_from', v.date_from, 'date_to', v.date_to,
                         'changes', to_jsonb(v.changes)));
  end if;
  return null;
end;
$$;

create constraint trigger calendar_pending_events_flush
  after insert on private.calendar_pending_events
  deferrable initially deferred
  for each row execute function private.flush_calendar_event();

-- Creates missing night rows for a root listing in [p_from, p_to). Returns rows created.
create or replace function private.ensure_calendar_days(p_listing_id uuid, p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_to <= p_from then
    return 0;
  end if;
  insert into public.calendar_days (listing_id, account_id, night)
  select l.id, l.account_id, p_from + i
  from public.listings l
  cross join generate_series(0, p_to - p_from - 1) i
  where l.id = p_listing_id and l.type in ('single', 'multi_parent')
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- CAL-03: serialise every availability write of a listing group on its root's night rows.
-- Callers lock roots in ascending id order; rows are locked in night order (no deadlocks).
create or replace function private.lock_calendar_nights(p_root_id uuid, p_from date, p_to date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_calendar_days(p_root_id, p_from, p_to);
  perform 1 from public.calendar_days d
  where d.listing_id = p_root_id and d.night >= p_from and d.night < p_to
  order by d.night
  for update;
end;
$$;

-- ---------------------------------------------------------------------------
-- Night state (derived)
-- ---------------------------------------------------------------------------

-- Effective price, rules, block reasons and status for each listing-night in [p_from, p_to).
-- Works for single, sub_unit and multi_parent rows (a parent's own reasons only; allotment is
-- added by get_calendar). Callers check permissions.
create or replace function private.calendar_nights(
  p_listing_ids uuid[],
  p_from date,
  p_to date,
  p_ignore_hold_id uuid default null
)
returns table (
  listing_id uuid,
  night date,
  root_id uuid,
  listing_type public.listing_type,
  price_cents integer,
  price_source text,
  min_nights integer,
  min_nights_source text,
  max_nights integer,
  max_nights_source text,
  closed_to_arrival boolean,
  closed_to_departure boolean,
  closed boolean,
  reasons jsonb,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Written with LATERAL index lookups throughout: this SQL function is planned generically
  -- (parameters unknown), and joins must not fall back to scanning calendar_days. `offset 0`
  -- keeps each lookup a correlated index probe (stops the planner from flattening it).
  with u as materialized (
    select l.id, l.type, r.id as root_id,
           r.base_price_cents, r.weekend_price_cents, r.weekend_nights,
           r.min_nights as d_min, r.max_nights as d_max,
           r.preparation_nights as prep, r.booking_window_days as window_days,
           (now() at time zone r.timezone)::date as today,
           ((now() + make_interval(hours => r.advance_notice_hours)) at time zone r.timezone)::date as first_bookable
    from (select distinct x from unnest(p_listing_ids) x) ids
    cross join lateral (select * from public.listings l where l.id = ids.x and l.type <> 'complex' offset 0) l
    cross join lateral (select * from public.listings r where r.id = coalesce(l.parent_id, l.id) offset 0) r
  ),
  h as materialized (
    select h.id, h.listing_id, h.nights, h.check_in, h.check_out, h.source_type, h.source_id,
           h.exclusive, h.note, h.block_reason
    from (select u.id as lid from u union select u.root_id from u) ids
    cross join lateral (
      select * from public.calendar_holds h
      where h.listing_id = ids.lid
        and h.status = 'active'
        and h.nights && daterange(p_from - 31, p_to + 31)
      offset 0
    ) h
    where (h.expires_at is null or h.expires_at > now())
      and h.id is distinct from p_ignore_hold_id
  ),
  n as (
    select u.*, p_from + i as night
    from u cross join generate_series(0, p_to - p_from - 1) i
  )
  select n.id, n.night, n.root_id, n.type,
         coalesce(d.price_override_cents, private.listing_night_price(n.base_price_cents, n.weekend_price_cents, n.weekend_nights, n.night)),
         case when d.price_override_cents is not null then 'override'
              else private.listing_night_price_source(n.weekend_price_cents, n.weekend_nights, n.night) end,
         coalesce(d.min_nights_override, n.d_min),
         case when d.min_nights_override is null then 'listing' else 'override' end,
         coalesce(d.max_nights_override, n.d_max),
         case when d.max_nights_override is null then 'listing' else 'override' end,
         coalesce(d.closed_to_arrival, false),
         coalesce(d.closed_to_departure, false),
         coalesce(d.closed, false),
         r.reasons,
         case when r.booked then 'booked' when jsonb_array_length(r.reasons) > 0 then 'blocked' else 'available' end
  from n
  left join lateral (
    select * from public.calendar_days d where d.listing_id = n.root_id and d.night = n.night offset 0
  ) d on true
  cross join lateral (
    select coalesce(jsonb_agg(x.reason order by x.ord, x.k), '[]'::jsonb) as reasons,
           coalesce(bool_or(x.booked), false) as booked
    from (
      -- Holds on the unit itself, and blocks on a sub-unit's parent (they close the whole group).
      select 1 as ord, h.check_in::text || h.id::text as k,
             jsonb_build_object(
               'reason', case h.source_type when 'ical' then 'ical_import' else h.source_type end,
               'hold_id', h.id, 'source_type', h.source_type, 'source_id', h.source_id,
               'listing_id', h.listing_id, 'note', h.note, 'block_reason', h.block_reason) as reason,
             h.source_type in ('reservation', 'quote') as booked
      from h
      where h.nights @> n.night
        and (h.listing_id = n.id or (n.type = 'sub_unit' and h.listing_id = n.root_id))
      union all
      -- CAL-08 preparation time: N nights before and after each exclusive hold on the unit.
      select 2, h.check_in::text || h.id::text, jsonb_build_object('reason', 'preparation', 'hold_id', h.id), false
      from h
      where n.prep > 0 and h.exclusive and h.listing_id = n.id
        and not (h.nights @> n.night)
        and n.night >= h.check_in - n.prep and n.night < h.check_out + n.prep
      union all
      select 3, '', '{"reason": "default_closed"}'::jsonb, false where coalesce(d.closed, false)
      union all
      select 4, '', '{"reason": "advance_notice"}'::jsonb, false where n.night < n.first_bookable
      union all
      select 5, '', '{"reason": "booking_window"}'::jsonb, false where n.night >= n.today + n.window_days
    ) x
  ) r
$$;

-- Picks the unit for a stay: the listing itself, or for a multi-unit parent (bookings only) the
-- first sub-unit by name that is free on every night. p_mode:
--   'booking' – everything but advance notice / booking window blocks (those are stay rules)
--   'block'   – only exclusive holds block (a manual block may not cover a reservation)
-- Returns unit_id null plus the conflicts when nothing is free.
create or replace function private.find_free_unit(
  p_listing public.listings,
  p_check_in date,
  p_check_out date,
  p_ignore_hold_id uuid,
  p_mode text
)
returns table (unit_id uuid, conflicts jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_units uuid[];
begin
  if p_listing.type = 'multi_parent' and p_mode = 'booking' then
    select array_agg(c.id order by c.internal_name, c.id) into v_units
    from public.listings c where c.parent_id = p_listing.id and c.status = 'active';
    if v_units is null then
      return query select null::uuid, '[{"reason": "no_units_available"}]'::jsonb;
      return;
    end if;
  else
    v_units := array[p_listing.id];
  end if;

  return query
  with per_unit as (
    select n.listing_id as unit,
           coalesce(jsonb_agg(jsonb_build_object('night', n.night, 'reasons', b.reasons) order by n.night)
                    filter (where b.reasons <> '[]'::jsonb), '[]'::jsonb) as conflicts
    from private.calendar_nights(v_units, p_check_in, p_check_out, p_ignore_hold_id) n
    cross join lateral (
      select coalesce(jsonb_agg(r), '[]'::jsonb) as reasons
      from jsonb_array_elements(n.reasons) r
      where case p_mode
              when 'block' then r ->> 'reason' in ('reservation', 'quote', 'owner_stay')
              else r ->> 'reason' not in ('advance_notice', 'booking_window')
            end
    ) b
    group by n.listing_id
  ),
  free as (
    select p.unit from per_unit p where p.conflicts = '[]'::jsonb
    order by array_position(v_units, p.unit) limit 1
  )
  select f.unit, '[]'::jsonb from free f
  union all
  select null::uuid,
         case when p_listing.type = 'multi_parent' and p_mode = 'booking'
              then '[{"reason": "no_units_available"}]'::jsonb
              else (select p.conflicts from per_unit p limit 1) end
  where not exists (select 1 from free);
end;
$$;

create or replace function private.describe_conflicts(p_conflicts jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(string_agg(distinct
           (r ->> 'reason') || coalesce(' ' || (r ->> 'source_id'), '')
             || coalesce(' (hold ' || (r ->> 'hold_id') || ')', ''), ', '), 'unavailable')
  from jsonb_array_elements(coalesce(p_conflicts, '[]'::jsonb)) c
  cross join lateral jsonb_array_elements(coalesce(c -> 'reasons', jsonb_build_array(c))) r
$$;

-- Stay rules (CAL-02, CAL-06) other than blocked nights, in reporting order.
create or replace function private.stay_rule_failures(p_listing public.listings, p_check_in date, p_check_out date, p_guests integer)
returns table (ord integer, code text, message text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r public.listings := private.rules_listing(p_listing);
  v_nights integer := p_check_out - p_check_in;
  v_today date;
  v_first date;
  v_min integer;
  v_max integer;
  v_cta boolean;
  v_ctd boolean;
begin
  if p_listing.type = 'complex' then
    return query select 0, 'listing_not_bookable', 'A complex cannot be booked.';
    return;
  end if;
  if v_r.status <> 'active' or p_listing.status <> 'active' then
    return query select 0, 'listing_not_active', 'The listing is not active.';
    return;
  end if;
  if p_check_in is null or p_check_out is null or v_nights < 1 or v_nights > 365 then
    return query select 1, 'invalid_dates', 'Check-out must be 1 to 365 nights after check-in.';
    return;
  end if;

  v_today := (now() at time zone v_r.timezone)::date;
  v_first := ((now() + make_interval(hours => v_r.advance_notice_hours)) at time zone v_r.timezone)::date;

  if coalesce(p_guests, 1) < 1 then
    return query select 2, 'capacity', 'At least one guest is required.';
  elsif v_r.max_guests is not null and p_guests > v_r.max_guests then
    return query select 2, 'capacity', format('At most %s guests.', v_r.max_guests);
  end if;
  if p_check_in < v_first then
    return query select 3, 'advance_notice', format('Arrival must be on or after %s (advance notice).', v_first);
  end if;
  if p_check_out - 1 >= v_today + v_r.booking_window_days then
    return query select 4, 'booking_window', format('Every night must be before %s (booking window).', v_today + v_r.booking_window_days);
  end if;

  select coalesce(d.min_nights_override, v_r.min_nights), coalesce(d.max_nights_override, v_r.max_nights), coalesce(d.closed_to_arrival, false)
  into v_min, v_max, v_cta
  from (select 1) one
  left join public.calendar_days d on d.listing_id = v_r.id and d.night = p_check_in;
  select coalesce(d.closed_to_departure, false) into v_ctd
  from (select 1) one
  left join public.calendar_days d on d.listing_id = v_r.id and d.night = p_check_out;

  if v_nights < v_min then
    return query select 6, 'min_nights', format('Arrival on %s needs at least %s nights.', p_check_in, v_min);
  end if;
  if v_max is not null and v_nights > v_max then
    return query select 7, 'max_nights', format('Arrival on %s allows at most %s nights.', p_check_in, v_max);
  end if;
  if v_cta then
    return query select 8, 'closed_to_arrival', format('%s is closed to arrival.', p_check_in);
  end if;
  if v_ctd then
    return query select 9, 'closed_to_departure', format('%s is closed to departure.', p_check_out);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public read API
-- ---------------------------------------------------------------------------

-- CAL-02: can this listing be booked for these dates and guests? Returns every failing rule.
create or replace function public.check_availability(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_guests integer default 1,
  p_ignore_hold_id uuid default null
)
returns table (
  bookable boolean,
  reason text,
  failures text[],
  message text,
  nights integer,
  unit_id uuid,
  conflicts jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'calendar.view');
  v_fail record;
  v_codes text[] := '{}';
  v_msgs text[] := '{}';
  v_unit uuid;
  v_conf jsonb := '[]'::jsonb;
  v_blocked_added boolean := false;
begin
  for v_fail in select * from private.stay_rule_failures(v_l, p_check_in, p_check_out, p_guests) order by ord loop
    if v_fail.ord <= 1 then
      return query select false, v_fail.code, array[v_fail.code], v_fail.message, greatest(coalesce(p_check_out - p_check_in, 0), 0), null::uuid, '[]'::jsonb;
      return;
    end if;
    if v_fail.ord > 5 and not v_blocked_added then
      v_blocked_added := true;
      select f.unit_id, f.conflicts into v_unit, v_conf from private.find_free_unit(v_l, p_check_in, p_check_out, p_ignore_hold_id, 'booking') f;
      if v_unit is null then
        v_codes := array_append(v_codes, case when v_l.type = 'multi_parent' then 'no_units_available' else 'blocked' end);
        v_msgs := array_append(v_msgs, 'Some nights are not available: ' || private.describe_conflicts(v_conf));
      end if;
    end if;
    v_codes := array_append(v_codes, v_fail.code);
    v_msgs := array_append(v_msgs, v_fail.message);
  end loop;
  if not v_blocked_added then
    select f.unit_id, f.conflicts into v_unit, v_conf from private.find_free_unit(v_l, p_check_in, p_check_out, p_ignore_hold_id, 'booking') f;
    if v_unit is null then
      v_codes := array_append(v_codes, case when v_l.type = 'multi_parent' then 'no_units_available' else 'blocked' end);
      v_msgs := array_append(v_msgs, 'Some nights are not available: ' || private.describe_conflicts(v_conf));
    end if;
  end if;

  return query select
    cardinality(v_codes) = 0,
    v_codes[1],
    v_codes,
    array_to_string(v_msgs, ' '),
    p_check_out - p_check_in,
    case when v_unit is not null then v_unit when v_l.type <> 'multi_parent' then v_l.id end,
    coalesce(v_conf, '[]'::jsonb);
end;
$$;

-- Multi-calendar read: one row per listing-night, filtered to the listings the caller may see.
-- Multi-unit parents also requested get units_total / units_available (allotment, CAL-11).
create or replace function public.get_calendar(p_listing_ids uuid[], p_from date, p_to date)
returns table (
  listing_id uuid,
  night date,
  listing_type public.listing_type,
  parent_id uuid,
  price_cents integer,
  price_source text,
  min_nights integer,
  max_nights integer,
  closed_to_arrival boolean,
  closed_to_departure boolean,
  closed boolean,
  status text,
  reasons jsonb,
  units_total integer,
  units_available integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_children uuid[];
  v_system boolean := private.calendar_is_system();
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 400 then
    raise exception 'invalid_range: up to 400 days, to after from' using errcode = '22023';
  end if;
  if cardinality(p_listing_ids) > 500 then
    raise exception 'too_many_listings: at most 500' using errcode = '22023';
  end if;
  select array_agg(l.id) into v_ids
  from public.listings l
  where l.id = any (p_listing_ids) and l.type <> 'complex'
    and (v_system or (auth.uid() is not null and private.can_view_listing_calendar(l.account_id, l.id)));
  if v_ids is null then
    return;
  end if;
  select array_agg(c.id) into v_children
  from public.listings c where c.parent_id = any (v_ids) and c.status = 'active';

  return query
  with nights as materialized (
    select * from private.calendar_nights(v_ids || coalesce(v_children, '{}'), p_from, p_to)
  ),
  alloc as (
    select n.root_id as parent_id, n.night,
           count(*)::integer as total,
           (count(*) filter (where n.status = 'available'))::integer as free,
           bool_or(n.status = 'booked') as any_booked
    from nights n
    where n.listing_id = any (v_children)
    group by n.root_id, n.night
  )
  select n.listing_id, n.night, n.listing_type, case when n.listing_type = 'sub_unit' then n.root_id end,
         n.price_cents, n.price_source, n.min_nights, n.max_nights,
         n.closed_to_arrival, n.closed_to_departure, n.closed,
         case when n.listing_type <> 'multi_parent' then n.status
              when coalesce(a.free, 0) > 0 then 'available'
              when coalesce(a.any_booked, false) and jsonb_array_length(n.reasons) = 0 then 'booked'
              else 'blocked' end,
         case when n.listing_type = 'multi_parent' and coalesce(a.free, 0) = 0 and jsonb_array_length(n.reasons) = 0
              then '[{"reason": "no_units_available"}]'::jsonb
              else n.reasons end,
         case when n.listing_type = 'multi_parent' then coalesce(a.total, 0) end,
         case when n.listing_type = 'multi_parent' then coalesce(a.free, 0) end
  from nights n
  left join alloc a on a.parent_id = n.listing_id and a.night = n.night
  where n.listing_id = any (v_ids)
  order by n.listing_id, n.night;
end;
$$;

-- CAL-05: itemised quote. Same rules as src/lib/calendar/quote.ts (parity is tested).
create or replace function public.quote_stay(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_guests integer default 1,
  p_pets integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'calendar.view');
  v_r public.listings;
  v_nights integer := p_check_out - p_check_in;
  v_nightly jsonb;
  v_missing text;
  v_sum bigint;
  v_lines jsonb;
  v_extra integer;
  v_bps integer;
  v_name text;
  v_code text;
  v_discount bigint;
begin
  if v_l.type = 'complex' then
    raise exception 'listing_not_bookable: %', p_listing_id using errcode = 'P0001';
  end if;
  if v_nights is null or v_nights < 1 or v_nights > 365 then
    raise exception 'invalid_dates: check-out must be 1 to 365 nights after check-in' using errcode = '22023';
  end if;
  if coalesce(p_guests, 0) < 1 or coalesce(p_pets, -1) < 0 then
    raise exception 'invalid_guests' using errcode = '22023';
  end if;
  v_r := private.rules_listing(v_l);

  select jsonb_agg(jsonb_build_object('night', n.night, 'price_cents', n.price_cents, 'source', n.price_source) order by n.night),
         string_agg(case when n.price_cents is null then n.night::text end, ', ' order by n.night),
         sum(n.price_cents)
  into v_nightly, v_missing, v_sum
  from private.calendar_nights(array[v_l.id], p_check_in, p_check_out) n;
  if v_missing is not null then
    raise exception 'price_missing: no price for %', v_missing using errcode = 'P0001';
  end if;

  v_lines := jsonb_build_array(jsonb_build_object(
    'code', 'accommodation', 'label', v_nights || case when v_nights = 1 then ' night' else ' nights' end,
    'quantity', v_nights, 'unit_amount_cents', null, 'amount_cents', v_sum));

  v_extra := case when v_r.extra_guest_after is null then 0 else greatest(p_guests - v_r.extra_guest_after, 0) end;
  if v_extra > 0 and v_r.extra_guest_fee_cents > 0 then
    v_lines := v_lines || jsonb_build_object('code', 'extra_guest_fee', 'label', 'Extra guests',
      'quantity', v_extra * v_nights, 'unit_amount_cents', v_r.extra_guest_fee_cents,
      'amount_cents', v_extra * v_nights * v_r.extra_guest_fee_cents::bigint);
  end if;
  if v_r.cleaning_fee_cents > 0 then
    v_lines := v_lines || jsonb_build_object('code', 'cleaning_fee', 'label', 'Cleaning fee', 'quantity', 1,
      'unit_amount_cents', v_r.cleaning_fee_cents, 'amount_cents', v_r.cleaning_fee_cents);
  end if;
  if p_pets > 0 and v_r.pet_fee_cents > 0 then
    v_lines := v_lines || jsonb_build_object('code', 'pet_fee', 'label', 'Pet fee', 'quantity', 1,
      'unit_amount_cents', v_r.pet_fee_cents, 'amount_cents', v_r.pet_fee_cents);
  end if;

  if v_nights >= 28 and v_r.monthly_discount_bps > 0 then
    v_bps := v_r.monthly_discount_bps; v_name := 'Monthly'; v_code := 'monthly_discount';
  elsif v_nights >= 7 and v_r.weekly_discount_bps > 0 then
    v_bps := v_r.weekly_discount_bps; v_name := 'Weekly'; v_code := 'weekly_discount';
  end if;
  if v_bps is not null then
    v_discount := (v_sum * v_bps + 5000) / 10000; -- half-up on non-negative integers
    if v_discount > 0 then
      v_lines := v_lines || jsonb_build_object('code', v_code,
        'label', format('%s discount (%s%%)', v_name, trim_scale(v_bps::numeric / 100)),
        'quantity', 1, 'unit_amount_cents', null, 'amount_cents', -v_discount);
    end if;
  end if;

  return jsonb_build_object(
    'listing_id', v_l.id, 'check_in', p_check_in, 'check_out', p_check_out, 'nights', v_nights,
    'currency', v_r.currency, 'guests', p_guests, 'pets', p_pets,
    'nightly', v_nightly, 'lines', v_lines,
    'total_cents', (select sum((x ->> 'amount_cents')::bigint) from jsonb_array_elements(v_lines) x));
end;
$$;

-- CAL-13: change history of one night (a sub-unit also sees its parent's price/rule changes).
create or replace function public.get_night_changes(p_listing_id uuid, p_night date)
returns table (
  id bigint,
  listing_id uuid,
  date_from date,
  date_to date,
  field text,
  old_value jsonb,
  new_value jsonb,
  source text,
  actor_type text,
  actor_id text,
  actor_user_id uuid,
  hold_id uuid,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'calendar.view');
begin
  return query
  select c.id, c.listing_id, lower(c.nights), upper(c.nights), c.field, c.old_value, c.new_value, c.source,
         c.actor_type, c.actor_id, c.actor_user_id, c.hold_id, c.occurred_at
  from public.calendar_changes c
  where c.listing_id in (v_l.id, coalesce(v_l.parent_id, v_l.id))
    and c.nights @> p_night
  order by c.occurred_at desc, c.id desc;
end;
$$;

-- May the caller read this listing's bookings summary? (properties.view or calendar.view within
-- listing scope, like the listings select policy.) Raises otherwise.
create or replace function private.authorize_listing_read(p_listing_id uuid)
returns public.listings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.listings;
begin
  select * into v from public.listings where id = p_listing_id;
  if not found then
    raise exception 'listing_not_found: %', p_listing_id using errcode = 'P0002';
  end if;
  if not private.calendar_is_system()
     and not ((private.has_permission(v.account_id, 'properties.view') or private.has_permission(v.account_id, 'calendar.view'))
              and private.can_access_listing(v.account_id, v.id, private.listing_scope_tags(v))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- For Properties (timezone-change confirmation): active holds of the listing, or of a parent's
-- sub-units, that end after today (listing-local). Includes manual and iCal blocks; filter on
-- source_type for bookings only.
create or replace function public.listing_future_holds(p_listing_id uuid)
returns table (
  hold_id uuid,
  listing_id uuid,
  source_type text,
  source_id uuid,
  check_in date,
  check_out date,
  expires_at timestamptz,
  note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v public.listings := private.authorize_listing_read(p_listing_id);
begin
  return query
  select h.id, h.listing_id, h.source_type, h.source_id, h.check_in, h.check_out, h.expires_at, h.note
  from public.calendar_holds h
  where h.status = 'active'
    and (h.expires_at is null or h.expires_at > now())
    and (h.listing_id = v.id or h.listing_id in (select c.id from public.listings c where c.parent_id = v.id))
    and h.check_out > (now() at time zone v.timezone)::date
  order by h.check_in, h.id;
end;
$$;

-- For Properties (multi-unit view): next arrival (reservation or owner stay starting today or
-- later, listing-local) per listing; for a parent, the earliest over its sub-units. Listings the
-- caller cannot read are skipped.
create or replace function public.next_arrivals(p_listing_ids uuid[])
returns table (listing_id uuid, check_in date, hold_id uuid, source_type text, source_id uuid, unit_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_system boolean := private.calendar_is_system();
begin
  if cardinality(p_listing_ids) > 500 then
    raise exception 'too_many_listings: at most 500' using errcode = '22023';
  end if;
  return query
  select l.id, n.check_in, n.id, n.source_type, n.source_id, n.listing_id
  from public.listings l
  cross join lateral (
    select h.* from public.calendar_holds h
    where h.status = 'active'
      and h.source_type in ('reservation', 'owner_stay')
      and (h.expires_at is null or h.expires_at > now())
      and (h.listing_id = l.id or h.listing_id in (select c.id from public.listings c where c.parent_id = l.id))
      and h.check_in >= (now() at time zone l.timezone)::date
    order by h.check_in, h.id
    limit 1
  ) n
  where l.id = any (p_listing_ids)
    and (v_system
         or (auth.uid() is not null
             and (private.has_permission(l.account_id, 'properties.view') or private.has_permission(l.account_id, 'calendar.view'))
             and private.can_access_listing(l.account_id, l.id, private.listing_scope_tags(l))));
end;
$$;

-- Contract (replaces the stub of 20261122000100): does the listing, or any sub-unit of a
-- multi-unit parent, have reservation or owner-stay holds on future nights?
create or replace function public.listing_has_future_bookings(p_listing_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.listings;
begin
  if not exists (select 1 from public.listings where id = p_listing_id) then
    return false;
  end if;
  v := private.authorize_listing_read(p_listing_id);
  return exists (
    select 1 from public.calendar_holds h
    where h.status = 'active'
      and h.source_type in ('reservation', 'owner_stay')
      and (h.expires_at is null or h.expires_at > now())
      and (h.listing_id = v.id or h.listing_id in (select c.id from public.listings c where c.parent_id = v.id))
      and h.check_out > (now() at time zone v.timezone)::date
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Holds (CAL-03, CAL-07, CAL-08, CAL-11)
-- ---------------------------------------------------------------------------

-- Marks overdue active holds as expired (optionally only some listings / nights). Returns count.
create or replace function private.expire_holds(p_listing_ids uuid[] default null, p_range daterange default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_count integer := 0;
  v_prep integer;
begin
  for v in
    update public.calendar_holds h
    set status = 'expired', released_at = now(), release_reason = 'expired'
    where h.status = 'active' and h.expires_at <= now()
      and (p_listing_ids is null or h.listing_id = any (p_listing_ids))
      and (p_range is null or h.nights && p_range)
    returning h.*
  loop
    v_count := v_count + 1;
    select r.preparation_nights into v_prep
    from public.listings l join public.listings r on r.id = coalesce(l.parent_id, l.id) where l.id = v.listing_id;
    perform private.log_calendar_change(v.account_id, v.listing_id, v.nights, 'availability',
      jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'active'),
      jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'expired'), v.id);
    perform private.note_calendar_change(v.listing_id,
      v.check_in - case when v.exclusive then coalesce(v_prep, 0) else 0 end,
      v.check_out + case when v.exclusive then coalesce(v_prep, 0) else 0 end, array['availability']);
  end loop;
  return v_count;
end;
$$;

create or replace function private.place_hold_internal(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_source_type text,
  p_source_id uuid,
  p_expires_at timestamptz,
  p_note text,
  p_block_reason text,
  p_enforce_rules boolean,
  p_guests integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings;
  v_r public.listings;
  v_exclusive boolean := p_source_type in ('reservation', 'quote', 'owner_stay');
  v_prep integer;
  v_unit uuid;
  v_conf jsonb;
  v_fail text;
  v_id uuid;
begin
  if p_source_type is null or p_source_type not in ('reservation', 'quote', 'owner_stay', 'manual_block', 'ical') then
    raise exception 'invalid_source_type: %', p_source_type using errcode = '22023';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in or p_check_out - p_check_in > 1100 then
    raise exception 'invalid_dates: check-out must be 1 to 1100 nights after check-in' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'invalid_expiry: expires_at is in the past' using errcode = '22023';
  end if;

  v_l := private.calendar_authorize(p_listing_id, private.hold_permission(p_source_type, 'place'));
  v_r := private.rules_listing(v_l);
  if v_l.type = 'complex' or v_l.status = 'archived' or v_r.status = 'archived' then
    raise exception 'listing_not_bookable: % is %', p_listing_id, case when v_l.type = 'complex' then 'a complex' else 'archived' end
      using errcode = 'P0001';
  end if;
  -- Reservations, quotes and owner stays need an active listing (and an active parent for a
  -- sub-unit); manual and iCal blocks may be prepared on drafts.
  if v_exclusive and (v_l.status <> 'active' or v_r.status <> 'active') then
    raise exception 'listing_not_bookable: % is not active', p_listing_id using errcode = 'P0001';
  end if;
  v_prep := case when v_exclusive then v_r.preparation_nights else 0 end;

  perform private.lock_calendar_nights(v_r.id, p_check_in - v_r.preparation_nights, p_check_out + v_r.preparation_nights);
  perform private.expire_holds(
    array(select v_r.id union all select c.id from public.listings c where c.parent_id = v_r.id),
    daterange(p_check_in - v_r.preparation_nights, p_check_out + v_r.preparation_nights));

  if p_enforce_rules then
    select string_agg(f.code, ', ' order by f.ord) into v_fail
    from private.stay_rule_failures(v_l, p_check_in, p_check_out, p_guests) f;
    if v_fail is not null then
      raise exception 'calendar_rule_violation: %', v_fail using errcode = 'P0001';
    end if;
  end if;

  if p_source_type = 'ical' then
    v_unit := v_l.id; -- external events are always recorded (step 5)
  else
    select f.unit_id, f.conflicts into v_unit, v_conf
    from private.find_free_unit(v_l, p_check_in, p_check_out, null,
                                case when v_exclusive then 'booking' else 'block' end) f;
    if v_unit is null then
      raise exception 'calendar_conflict: listing %, % to %: %', v_l.id, p_check_in, p_check_out, private.describe_conflicts(v_conf)
        using errcode = '23P01', detail = coalesce(v_conf, '[]'::jsonb)::text;
    end if;
  end if;

  insert into public.calendar_holds (account_id, listing_id, requested_listing_id, check_in, check_out, source_type,
                                     source_id, expires_at, block_reason, note, created_by)
  values (v_l.account_id, v_unit, v_l.id, p_check_in, p_check_out, p_source_type, p_source_id, p_expires_at,
          case when p_source_type = 'manual_block' then coalesce(p_block_reason, 'other') end,
          nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;

  perform private.log_calendar_change(v_l.account_id, v_unit, daterange(p_check_in, p_check_out), 'availability', null,
    jsonb_build_object('hold_id', v_id, 'source_type', p_source_type, 'source_id', p_source_id, 'status', 'active'), v_id);
  perform private.note_calendar_change(v_unit, p_check_in - v_prep, p_check_out + v_prep, array['availability']);
  return v_id;
end;
$$;

-- CAL-03: atomically hold [check_in, check_out) on a listing. On a multi-unit parent a free
-- sub-unit is assigned (CAL-11). Fails with SQLSTATE 23P01 'calendar_conflict: …' naming the
-- conflicting reservation/block. Stay rules (min nights, CTA, …) only with p_enforce_rules.
-- source_type: reservation | quote | owner_stay (exclusive) | manual_block | ical.
create or replace function public.place_hold(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_source_type text,
  p_source_id uuid default null,
  p_expires_at timestamptz default null,
  p_note text default null,
  p_block_reason text default null,
  p_enforce_rules boolean default false,
  p_guests integer default 1
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.place_hold_internal(p_listing_id, p_check_in, p_check_out, p_source_type, p_source_id,
                                     p_expires_at, p_note, p_block_reason, p_enforce_rules, p_guests)
$$;

-- Frees a hold's nights. Idempotent: releasing a released or expired hold does nothing.
create or replace function public.release_hold(p_hold_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.calendar_holds;
  v_r public.listings;
  v_prep integer;
begin
  select * into v from public.calendar_holds where id = p_hold_id for update;
  if not found then
    raise exception 'hold_not_found: %', p_hold_id using errcode = 'P0002';
  end if;
  perform private.calendar_authorize(v.listing_id, private.hold_permission(v.source_type, 'release'));
  if v.status <> 'active' then
    return;
  end if;
  update public.calendar_holds
  set status = 'released', released_at = now(), release_reason = left(p_reason, 500)
  where id = v.id;
  v_r := private.rules_listing((select l from public.listings l where l.id = v.listing_id));
  v_prep := case when v.exclusive then v_r.preparation_nights else 0 end;
  perform private.log_calendar_change(v.account_id, v.listing_id, v.nights, 'availability',
    jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'active'),
    jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'released'), v.id);
  perform private.note_calendar_change(v.listing_id, v.check_in - v_prep, v.check_out + v_prep, array['availability']);
end;
$$;

-- Moves an active hold to new dates and/or another listing (alterations, relocation, CAL-11
-- reassignment by drag). On a multi-unit parent the current sub-unit is kept when it is free,
-- else another free one is assigned. Preparation nights follow automatically. Returns the unit.
create or replace function public.move_hold(
  p_hold_id uuid,
  p_check_in date,
  p_check_out date,
  p_listing_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.calendar_holds;
  v_old public.listings;
  v_target public.listings;
  v_r public.listings;
  v_old_r public.listings;
  v_cur public.listings;
  v_mode text;
  v_unit uuid;
  v_conf jsonb;
  v_prep integer;
  v_old_prep integer;
  v_root uuid;
begin
  select * into v from public.calendar_holds where id = p_hold_id for update;
  if not found then
    raise exception 'hold_not_found: %', p_hold_id using errcode = 'P0002';
  end if;
  if v.status <> 'active' then
    raise exception 'hold_not_active: % is %', p_hold_id, v.status using errcode = 'P0001';
  end if;
  if v.source_type = 'ical' then
    raise exception 'hold_not_movable: iCal blocks follow their feed' using errcode = 'P0001';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in or p_check_out - p_check_in > 1100 then
    raise exception 'invalid_dates: check-out must be 1 to 1100 nights after check-in' using errcode = '22023';
  end if;

  v_old := private.calendar_authorize(v.listing_id, private.hold_permission(v.source_type, 'move'));
  v_target := private.calendar_authorize(coalesce(p_listing_id, v.listing_id), private.hold_permission(v.source_type, 'move'));
  if v_target.account_id <> v.account_id then
    raise exception 'listing_not_found: %', v_target.id using errcode = 'P0002';
  end if;
  v_r := private.rules_listing(v_target);
  v_old_r := private.rules_listing(v_old);
  if v_target.type = 'complex' or v_target.status = 'archived' or v_r.status = 'archived'
     or (v.exclusive and (v_target.status <> 'active' or v_r.status <> 'active')) then
    raise exception 'listing_not_bookable: %', v_target.id using errcode = 'P0001';
  end if;
  v_mode := case when v.exclusive then 'booking' else 'block' end;
  v_prep := case when v.exclusive then v_r.preparation_nights else 0 end;
  v_old_prep := case when v.exclusive then v_old_r.preparation_nights else 0 end;

  -- Lock order: roots ascending.
  for v_root in select x from unnest(array[v_old_r.id, v_r.id]) x group by x order by x loop
    if v_root = v_r.id then
      perform private.lock_calendar_nights(v_root, p_check_in - v_r.preparation_nights, p_check_out + v_r.preparation_nights);
    else
      perform private.lock_calendar_nights(v_root, v.check_in, v.check_out);
    end if;
  end loop;
  perform private.expire_holds(
    array(select v_r.id union all select c.id from public.listings c where c.parent_id = v_r.id),
    daterange(p_check_in - v_r.preparation_nights, p_check_out + v_r.preparation_nights));

  if v_target.type = 'multi_parent' and v.exclusive and v_old.parent_id = v_target.id then
    -- Keep the current sub-unit if it is free for the new dates.
    v_cur := v_old;
    select f.unit_id into v_unit from private.find_free_unit(v_cur, p_check_in, p_check_out, v.id, v_mode) f;
  end if;
  if v_unit is null then
    select f.unit_id, f.conflicts into v_unit, v_conf
    from private.find_free_unit(v_target, p_check_in, p_check_out, v.id, v_mode) f;
  end if;
  if v_unit is null then
    raise exception 'calendar_conflict: listing %, % to %: %', v_target.id, p_check_in, p_check_out, private.describe_conflicts(v_conf)
      using errcode = '23P01', detail = coalesce(v_conf, '[]'::jsonb)::text;
  end if;

  update public.calendar_holds
  set listing_id = v_unit,
      requested_listing_id = case when p_listing_id is null then requested_listing_id else p_listing_id end,
      check_in = p_check_in,
      check_out = p_check_out
  where id = v.id;

  perform private.log_calendar_change(v.account_id, v.listing_id, v.nights, 'availability',
    jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'active'),
    jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'moved',
                       'listing_id', v_unit, 'check_in', p_check_in, 'check_out', p_check_out), v.id);
  perform private.log_calendar_change(v.account_id, v_unit, daterange(p_check_in, p_check_out), 'availability',
    jsonb_build_object('hold_id', v.id, 'moved_from', jsonb_build_object('listing_id', v.listing_id, 'check_in', v.check_in, 'check_out', v.check_out)),
    jsonb_build_object('hold_id', v.id, 'source_type', v.source_type, 'source_id', v.source_id, 'status', 'active'), v.id);
  perform private.note_calendar_change(v.listing_id, v.check_in - v_old_prep, v.check_out + v_old_prep, array['availability']);
  perform private.note_calendar_change(v_unit, p_check_in - v_prep, p_check_out + v_prep, array['availability']);
  return v_unit;
end;
$$;

-- CAL-07: manual block on one or many listings, all or nothing. With p_preview, returns the
-- nights and conflicts without writing.
create or replace function public.block_dates(
  p_listing_ids uuid[],
  p_from date,
  p_to date,
  p_block_reason text default 'other',
  p_note text default null,
  p_preview boolean default false
)
returns table (listing_id uuid, hold_id uuid, nights integer, conflicts jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v record;
  v_unit uuid;
  v_conf jsonb;
  v_all jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_l public.listings;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 1100 then
    raise exception 'invalid_dates: to must be 1 to 1100 days after from' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_listing_ids), 0) = 0 or cardinality(p_listing_ids) > 500 then
    raise exception 'invalid_listings: 1 to 500 listings' using errcode = '22023';
  end if;
  if coalesce(p_block_reason, 'other') not in ('maintenance', 'personal_use', 'other') then
    raise exception 'invalid_block_reason: %', p_block_reason using errcode = '22023';
  end if;

  for v in
    select l.id, coalesce(l.parent_id, l.id) as root_id
    from public.listings l
    where l.id in (select distinct x from unnest(p_listing_ids) x)
    order by coalesce(l.parent_id, l.id), l.id
  loop
    v_l := private.calendar_authorize(v.id, 'calendar.block');
    if v_l.type = 'complex' or v_l.status = 'archived' then
      raise exception 'listing_not_bookable: %', v.id using errcode = 'P0001';
    end if;
    if not p_preview then
      perform private.lock_calendar_nights(v.root_id, p_from, p_to);
    end if;
    select f.unit_id, f.conflicts into v_unit, v_conf from private.find_free_unit(v_l, p_from, p_to, null, 'block') f;
    v_rows := v_rows || jsonb_build_object('listing_id', v.id, 'conflicts', coalesce(v_conf, '[]'::jsonb));
    if v_unit is null then
      v_all := v_all || coalesce(v_conf, '[]'::jsonb);
    end if;
  end loop;
  if (select count(*) from unnest(p_listing_ids) x where x not in (select (r ->> 'listing_id')::uuid from jsonb_array_elements(v_rows) r)) > 0 then
    raise exception 'listing_not_found' using errcode = 'P0002';
  end if;

  if p_preview then
    return query select (r ->> 'listing_id')::uuid, null::uuid, p_to - p_from, r -> 'conflicts' from jsonb_array_elements(v_rows) r;
    return;
  end if;
  if v_all <> '[]'::jsonb then
    raise exception 'calendar_conflict: % to %: %', p_from, p_to, private.describe_conflicts(v_all)
      using errcode = '23P01', detail = v_all::text;
  end if;

  return query
  select (r ->> 'listing_id')::uuid,
         private.place_hold_internal((r ->> 'listing_id')::uuid, p_from, p_to, 'manual_block', null, null,
                                     p_note, coalesce(p_block_reason, 'other'), false, 1),
         p_to - p_from,
         '[]'::jsonb
  from jsonb_array_elements(v_rows) r;
end;
$$;

-- CAL-07: unblock [p_from, p_to) on listings: manual blocks inside are released, blocks crossing
-- the edges are trimmed, a block spanning the range is split in two.
create or replace function public.unblock_dates(
  p_listing_ids uuid[],
  p_from date,
  p_to date,
  p_preview boolean default false
)
returns table (listing_id uuid, holds_released integer, holds_trimmed integer, holds_split integer, nights_unblocked integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_l public.listings;
  h public.calendar_holds;
  v_released integer;
  v_trimmed integer;
  v_split integer;
  v_nights date[];
  v_cut daterange;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 1100 then
    raise exception 'invalid_dates: to must be 1 to 1100 days after from' using errcode = '22023';
  end if;
  for v_id in select distinct x from unnest(p_listing_ids) x order by x loop
    v_l := private.calendar_authorize(v_id, 'calendar.block');
    v_released := 0; v_trimmed := 0; v_split := 0; v_nights := '{}';
    for h in
      select * from public.calendar_holds c
      where c.listing_id = v_id and c.source_type = 'manual_block' and c.status = 'active'
        and c.nights && daterange(p_from, p_to)
      order by c.check_in
      for update
    loop
      v_cut := h.nights * daterange(p_from, p_to);
      v_nights := v_nights || array(select lower(v_cut) + i from generate_series(0, upper(v_cut) - lower(v_cut) - 1) i);
      if p_preview then
        continue;
      end if;
      if h.check_in >= p_from and h.check_out <= p_to then
        update public.calendar_holds set status = 'released', released_at = now(), release_reason = 'unblocked' where id = h.id;
        v_released := v_released + 1;
      elsif h.check_in < p_from and h.check_out > p_to then
        update public.calendar_holds set check_out = p_from where id = h.id;
        insert into public.calendar_holds (account_id, listing_id, requested_listing_id, check_in, check_out, source_type,
                                           block_reason, note, split_from, created_by)
        values (h.account_id, h.listing_id, h.requested_listing_id, p_to, h.check_out, 'manual_block',
                h.block_reason, h.note, h.id, h.created_by);
        v_split := v_split + 1;
      elsif h.check_in < p_from then
        update public.calendar_holds set check_out = p_from where id = h.id;
        v_trimmed := v_trimmed + 1;
      else
        update public.calendar_holds set check_in = p_to where id = h.id;
        v_trimmed := v_trimmed + 1;
      end if;
      perform private.log_calendar_change(h.account_id, h.listing_id, v_cut, 'availability',
        jsonb_build_object('hold_id', h.id, 'source_type', 'manual_block', 'status', 'active'),
        jsonb_build_object('hold_id', h.id, 'source_type', 'manual_block', 'status', 'unblocked'), h.id);
      perform private.note_calendar_change(h.listing_id, lower(v_cut), upper(v_cut), array['availability']);
    end loop;
    return query select v_id, v_released, v_trimmed, v_split,
                        (select count(distinct n)::integer from unnest(v_nights) n);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prices and rules (CAL-04, CAL-06, CAL-12, CAL-13)
-- ---------------------------------------------------------------------------

-- Bulk update of [p_from, p_to) on listings (sub-units edit their parent), optionally only on
-- some weekdays (0 = Sunday). p_changes keys:
--   price: {"op": "set", "cents": n} | {"op": "add", "cents": ±n} | {"op": "percent", "percent": ±p} | {"op": "reset"}
--   min_nights, max_nights: integer, or null = listing default
--   closed_to_arrival, closed_to_departure, closed: boolean
-- Returns per listing the nights matched / changed, nights skipped by relative price ops (no
-- price at all) and per-field counts. With p_preview nothing is written.
create or replace function public.update_calendar(
  p_listing_ids uuid[],
  p_from date,
  p_to date,
  p_changes jsonb,
  p_days_of_week integer[] default null,
  p_preview boolean default false
)
returns table (listing_id uuid, nights_matched integer, nights_changed integer, skipped integer, fields jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_price jsonb := p_changes -> 'price';
  v_op text;
  v_cents integer;
  v_hundredths integer;
  v_roots uuid[] := '{}';
  v_id uuid;
  v_l public.listings;
  v_bad text;
  v_actor record;
  v_source text;
  v_ip inet := private.current_ip();
  v_request text := private.current_request_id();
  v record;
begin
  -- Validate input ---------------------------------------------------------------
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid_changes: expected a non-empty object' using errcode = '22023';
  end if;
  select string_agg(k, ', ') into v_bad from jsonb_object_keys(p_changes) k
  where k not in ('price', 'min_nights', 'max_nights', 'closed_to_arrival', 'closed_to_departure', 'closed');
  if v_bad is not null then
    raise exception 'invalid_changes: unknown field(s) %', v_bad using errcode = '22023';
  end if;
  if v_price is not null then
    v_op := v_price ->> 'op';
    if v_op = 'set' or v_op = 'add' then
      if (case when jsonb_typeof(v_price -> 'cents') is distinct from 'number' then true
               else (v_price ->> 'cents')::numeric <> trunc((v_price ->> 'cents')::numeric)
                    or abs((v_price ->> 'cents')::numeric) > 100000000
                    or (v_op = 'set' and (v_price ->> 'cents')::numeric < 0) end) then
        raise exception 'invalid_changes: price.cents must be an integer number of cents' using errcode = '22023';
      end if;
      v_cents := (v_price ->> 'cents')::integer;
    elsif v_op = 'percent' then
      if (case when jsonb_typeof(v_price -> 'percent') is distinct from 'number' then true
               else (v_price ->> 'percent')::numeric not between -100 and 1000
                    or (v_price ->> 'percent')::numeric * 100 <> trunc((v_price ->> 'percent')::numeric * 100) end) then
        raise exception 'invalid_changes: price.percent must be -100 to 1000 with at most two decimals' using errcode = '22023';
      end if;
      v_hundredths := ((v_price ->> 'percent')::numeric * 100)::integer;
    elsif v_op is distinct from 'reset' then
      raise exception 'invalid_changes: price.op must be set, add, percent or reset' using errcode = '22023';
    end if;
  end if;
  select string_agg(k, ', ') into v_bad from unnest(array['min_nights', 'max_nights']) k
  where p_changes ? k
    and case jsonb_typeof(p_changes -> k)
          when 'null' then false
          when 'number' then (p_changes ->> k)::numeric <> trunc((p_changes ->> k)::numeric)
                             or (p_changes ->> k)::numeric not between 1 and 365
          else true
        end;
  if v_bad is not null then
    raise exception 'invalid_changes: % must be 1 to 365 nights or null', v_bad using errcode = '22023';
  end if;
  select string_agg(k, ', ') into v_bad from unnest(array['closed_to_arrival', 'closed_to_departure', 'closed']) k
  where p_changes ? k and jsonb_typeof(p_changes -> k) <> 'boolean';
  if v_bad is not null then
    raise exception 'invalid_changes: % must be true or false', v_bad using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 1100 then
    raise exception 'invalid_dates: to must be 1 to 1100 days after from' using errcode = '22023';
  end if;
  if p_days_of_week is not null and exists (select 1 from unnest(p_days_of_week) d where d is null or d not between 0 and 6) then
    raise exception 'invalid_days_of_week: 0 (Sunday) to 6' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_listing_ids), 0) = 0 or cardinality(p_listing_ids) > 500 then
    raise exception 'invalid_listings: 1 to 500 listings' using errcode = '22023';
  end if;

  -- Resolve listings to their roots (rules live on the parent) -------------------
  foreach v_id in array p_listing_ids loop
    v_l := private.calendar_authorize(v_id, 'calendar.edit');
    if v_l.type = 'complex' then
      raise exception 'listing_not_editable: % is a complex', v_id using errcode = 'P0001';
    end if;
    if v_l.type = 'sub_unit' then
      perform private.calendar_authorize(v_l.parent_id, 'calendar.edit');
      v_id := v_l.parent_id;
    end if;
    if not v_id = any (v_roots) then
      v_roots := v_roots || v_id;
    end if;
  end loop;
  v_roots := array(select x from unnest(v_roots) x order by x);

  if not p_preview then
    foreach v_id in array v_roots loop
      perform private.lock_calendar_nights(v_id, p_from, p_to);
    end loop;
  end if;

  -- Compute ------------------------------------------------------------------------
  drop table if exists pg_temp.calendar_update_nights;
  create temp table calendar_update_nights on commit drop as
  select c.*,
         case
           when v_op is null then c.o_price
           when v_op = 'set' then v_cents
           when v_op = 'reset' then null
           when c.cur_price is null then c.o_price
           when v_op = 'add' then c.cur_price + v_cents
           else round(c.cur_price::numeric * (10000 + v_hundredths) / 10000)::integer
         end as n_price,
         (v_op in ('add', 'percent') and c.cur_price is null) as skipped,
         case when p_changes ? 'min_nights' then (p_changes ->> 'min_nights')::integer else c.o_min end as n_min,
         case when p_changes ? 'max_nights' then (p_changes ->> 'max_nights')::integer else c.o_max end as n_max,
         case when p_changes ? 'closed_to_arrival' then (p_changes ->> 'closed_to_arrival')::boolean else c.o_cta end as n_cta,
         case when p_changes ? 'closed_to_departure' then (p_changes ->> 'closed_to_departure')::boolean else c.o_ctd end as n_ctd,
         case when p_changes ? 'closed' then (p_changes ->> 'closed')::boolean else c.o_closed end as n_closed
  from (
    select r.id as listing_id, r.account_id, p_from + i as night,
           d.price_override_cents as o_price, d.min_nights_override as o_min, d.max_nights_override as o_max,
           coalesce(d.closed_to_arrival, false) as o_cta, coalesce(d.closed_to_departure, false) as o_ctd,
           coalesce(d.closed, false) as o_closed,
           private.listing_night_price(r.base_price_cents, r.weekend_price_cents, r.weekend_nights, p_from + i) as list_price,
           private.listing_night_price_source(r.weekend_price_cents, r.weekend_nights, p_from + i) as list_source,
           coalesce(d.price_override_cents,
                    private.listing_night_price(r.base_price_cents, r.weekend_price_cents, r.weekend_nights, p_from + i)) as cur_price,
           r.min_nights as l_min, r.max_nights as l_max
    from public.listings r
    cross join generate_series(0, p_to - p_from - 1) i
    left join public.calendar_days d on d.listing_id = r.id and d.night = p_from + i
    where r.id = any (v_roots)
      and (p_days_of_week is null or extract(dow from p_from + i)::integer = any (p_days_of_week))
  ) c;

  if exists (select 1 from pg_temp.calendar_update_nights u where u.n_price < 0) then
    raise exception 'price_negative: the change would make % night(s) negative',
      (select count(*) from pg_temp.calendar_update_nights u where u.n_price < 0) using errcode = '22023';
  end if;
  if exists (select 1 from pg_temp.calendar_update_nights u
             where coalesce(u.n_min, u.l_min) > coalesce(u.n_max, u.l_max)) then
    raise exception 'min_nights_exceeds_max_nights: min nights would be above max nights' using errcode = '22023';
  end if;

  drop table if exists pg_temp.calendar_update_diffs;
  create temp table calendar_update_diffs on commit drop as
  select u.listing_id, u.account_id, u.night, f.field, f.old_value, f.new_value
  from pg_temp.calendar_update_nights u
  cross join lateral (
    select 'price' as field,
           jsonb_build_object('value', coalesce(u.o_price, u.list_price), 'source', case when u.o_price is null then u.list_source else 'override' end) as old_value,
           jsonb_build_object('value', coalesce(u.n_price, u.list_price), 'source', case when u.n_price is null then u.list_source else 'override' end) as new_value
    where u.n_price is distinct from u.o_price
    union all
    select 'min_nights',
           jsonb_build_object('value', coalesce(u.o_min, u.l_min), 'source', case when u.o_min is null then 'listing' else 'override' end),
           jsonb_build_object('value', coalesce(u.n_min, u.l_min), 'source', case when u.n_min is null then 'listing' else 'override' end)
    where u.n_min is distinct from u.o_min
    union all
    select 'max_nights',
           jsonb_build_object('value', coalesce(u.o_max, u.l_max), 'source', case when u.o_max is null then 'listing' else 'override' end),
           jsonb_build_object('value', coalesce(u.n_max, u.l_max), 'source', case when u.n_max is null then 'listing' else 'override' end)
    where u.n_max is distinct from u.o_max
    union all
    select 'closed_to_arrival', to_jsonb(u.o_cta), to_jsonb(u.n_cta) where u.n_cta <> u.o_cta
    union all
    select 'closed_to_departure', to_jsonb(u.o_ctd), to_jsonb(u.n_ctd) where u.n_ctd <> u.o_ctd
    union all
    select 'closed', to_jsonb(u.o_closed), to_jsonb(u.n_closed) where u.n_closed <> u.o_closed
  ) f;

  -- Apply ----------------------------------------------------------------------------
  if not p_preview then
    update public.calendar_days d
    set price_override_cents = u.n_price,
        min_nights_override = u.n_min,
        max_nights_override = u.n_max,
        closed_to_arrival = u.n_cta,
        closed_to_departure = u.n_ctd,
        closed = u.n_closed,
        updated_at = now()
    from pg_temp.calendar_update_nights u
    where d.listing_id = u.listing_id and d.night = u.night
      and exists (select 1 from pg_temp.calendar_update_diffs x where x.listing_id = u.listing_id and x.night = u.night);

    select * into v_actor from private.current_actor();
    v_source := private.calendar_source();
    insert into public.calendar_changes (account_id, listing_id, nights, field, old_value, new_value, source,
                                         actor_type, actor_id, actor_user_id, ip, request_id)
    select g.account_id, g.listing_id, daterange(min(g.night), max(g.night) + 1), g.field, g.old_value, g.new_value,
           v_source, v_actor.actor_type, v_actor.actor_id, v_actor.user_id, v_ip, v_request
    from (
      select x.*, x.night - (row_number() over (partition by x.listing_id, x.field, x.old_value, x.new_value order by x.night))::integer as grp
      from pg_temp.calendar_update_diffs x
    ) g
    group by g.account_id, g.listing_id, g.field, g.old_value, g.new_value, g.grp;

    for v in
      select x.listing_id, min(x.night) as f, max(x.night) + 1 as t, array_agg(distinct x.field) as fields
      from pg_temp.calendar_update_diffs x group by x.listing_id
    loop
      perform private.note_calendar_change(v.listing_id, v.f, v.t, v.fields);
    end loop;
  end if;

  return query
  select u.listing_id,
         count(*)::integer,
         (select count(distinct x.night)::integer from pg_temp.calendar_update_diffs x where x.listing_id = u.listing_id),
         (count(*) filter (where u.skipped))::integer,
         coalesce((select jsonb_object_agg(s.field, s.n) from (
                     select x.field, count(*)::integer as n from pg_temp.calendar_update_diffs x
                     where x.listing_id = u.listing_id group by x.field) s), '{}'::jsonb)
  from pg_temp.calendar_update_nights u
  group by u.listing_id
  order by u.listing_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reacting to listing changes (contract: Properties calls nothing)
-- ---------------------------------------------------------------------------

-- Per-night change log for a listing default (price / min / max nights) on nights without an override.
create or replace function private.log_listing_default_change(p_old public.listings, p_new public.listings, p_field text, p_from date, p_to date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_source text := private.calendar_source();
begin
  select * into v_actor from private.current_actor();
  insert into public.calendar_changes (account_id, listing_id, nights, field, old_value, new_value, source,
                                       actor_type, actor_id, actor_user_id, ip, request_id)
  select p_new.account_id, p_new.id, daterange(min(g.night), max(g.night) + 1), p_field, g.old_value, g.new_value,
         v_source, v_actor.actor_type, v_actor.actor_id, v_actor.user_id, private.current_ip(), private.current_request_id()
  from (
    select x.*, x.night - (row_number() over (partition by x.old_value, x.new_value order by x.night))::integer as grp
    from (
      select p_from + i as night,
             case p_field
               when 'price' then jsonb_build_object(
                 'value', private.listing_night_price(p_old.base_price_cents, p_old.weekend_price_cents, p_old.weekend_nights, p_from + i),
                 'source', private.listing_night_price_source(p_old.weekend_price_cents, p_old.weekend_nights, p_from + i))
               when 'min_nights' then jsonb_build_object('value', p_old.min_nights, 'source', 'listing')
               else jsonb_build_object('value', p_old.max_nights, 'source', 'listing')
             end as old_value,
             case p_field
               when 'price' then jsonb_build_object(
                 'value', private.listing_night_price(p_new.base_price_cents, p_new.weekend_price_cents, p_new.weekend_nights, p_from + i),
                 'source', private.listing_night_price_source(p_new.weekend_price_cents, p_new.weekend_nights, p_from + i))
               when 'min_nights' then jsonb_build_object('value', p_new.min_nights, 'source', 'listing')
               else jsonb_build_object('value', p_new.max_nights, 'source', 'listing')
             end as new_value
      from generate_series(0, p_to - p_from - 1) i
      left join public.calendar_days d on d.listing_id = p_new.id and d.night = p_from + i
      where case p_field
              when 'price' then d.price_override_cents is null
              when 'min_nights' then d.min_nights_override is null
              else d.max_nights_override is null
            end
    ) x
    where x.old_value is distinct from x.new_value
  ) g
  group by g.old_value, g.new_value, g.grp;
end;
$$;

create or replace function private.calendar_on_listing_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_end date;
  v_changes text[] := '{}';
  v_root boolean := new.type in ('single', 'multi_parent');
begin
  if new.type = 'complex' and (tg_op = 'INSERT' or old.type = 'complex') then
    return null;
  end if;
  v_today := (now() at time zone new.timezone)::date;
  v_end := private.calendar_horizon_end(new);

  if tg_op = 'INSERT' then
    if v_root and new.status <> 'archived' then
      perform private.ensure_calendar_days(new.id, v_today, v_end);
    end if;
    if new.type = 'sub_unit' then
      perform private.queue_calendar_event(new.account_id, new.parent_id, v_today, v_end, array['availability']);
    end if;
    return null;
  end if;

  if v_root and new.status <> 'archived'
     and (old.status, old.type, old.booking_window_days) is distinct from (new.status, new.type, new.booking_window_days) then
    perform private.ensure_calendar_days(new.id, v_today, v_end);
  end if;

  if v_root then
    if (old.base_price_cents, old.weekend_price_cents, old.weekend_nights)
       is distinct from (new.base_price_cents, new.weekend_price_cents, new.weekend_nights) then
      perform private.log_listing_default_change(old, new, 'price', v_today, v_end);
      v_changes := array_append(v_changes, 'price');
    end if;
    if old.min_nights is distinct from new.min_nights then
      perform private.log_listing_default_change(old, new, 'min_nights', v_today, v_end);
      v_changes := array_append(v_changes, 'min_nights');
    end if;
    if old.max_nights is distinct from new.max_nights then
      perform private.log_listing_default_change(old, new, 'max_nights', v_today, v_end);
      v_changes := array_append(v_changes, 'max_nights');
    end if;
  end if;
  if (old.advance_notice_hours, old.preparation_nights, old.booking_window_days, old.max_guests, old.timezone, old.status)
     is distinct from (new.advance_notice_hours, new.preparation_nights, new.booking_window_days, new.max_guests, new.timezone, new.status) then
    v_changes := array_append(v_changes, 'rules');
  end if;
  if (old.type, old.parent_id) is distinct from (new.type, new.parent_id) then
    v_changes := array_append(v_changes, 'availability');
    if old.parent_id is not null and old.parent_id is distinct from new.parent_id then
      perform private.queue_calendar_event(old.account_id, old.parent_id, v_today, v_end, array['availability']);
    end if;
  end if;
  if cardinality(v_changes) > 0 then
    perform private.note_calendar_change(new.id, v_today, v_end, v_changes);
  end if;
  return null;
end;
$$;

create trigger calendar_listing_changes
  after insert or update on public.listings
  for each row execute function private.calendar_on_listing_change();

-- ---------------------------------------------------------------------------
-- Pricing-tool API (CAL-15)
-- ---------------------------------------------------------------------------

create or replace function public.create_pricing_tool_token(p_account_id uuid, p_name text)
returns table (token_id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := 'pmspt_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  if not private.calendar_is_system() and not private.has_permission(p_account_id, 'calendar.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.calendar_api_tokens (account_id, name, token_hint, created_by)
  values (p_account_id, btrim(p_name), right(v_token, 4), auth.uid())
  returning id into v_id;
  insert into private.calendar_api_token_hashes (token_id, token_hash)
  values (v_id, encode(extensions.digest(v_token, 'sha256'), 'hex'));
  return query select v_id, v_token;
end;
$$;

create or replace function public.revoke_pricing_tool_token(p_token_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.calendar_api_tokens;
begin
  select * into v from public.calendar_api_tokens where id = p_token_id;
  if not found or (not private.calendar_is_system() and not private.has_permission(v.account_id, 'calendar.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.calendar_api_tokens set revoked_at = coalesce(revoked_at, now()) where id = p_token_id;
end;
$$;

-- Applies a batch of rate/availability updates from a pricing tool in one transaction.
-- p_updates: [{listing_id, from, to, price_cents?, min_nights?, max_nights?, closed_to_arrival?,
-- closed_to_departure?, closed?}], `to` exclusive, price_cents null = back to base price.
-- Service role only; the token decides the account, the change log records source pricing_tool.
create or replace function public.apply_pricing_tool_updates(p_token text, p_updates jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tok public.calendar_api_tokens;
  u jsonb;
  v_listing uuid;
  v_changes jsonb;
  v_results jsonb := '[]'::jsonb;
  r record;
begin
  select t.* into v_tok
  from public.calendar_api_tokens t
  join private.calendar_api_token_hashes h on h.token_id = t.id
  where h.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and t.revoked_at is null;
  if not found then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) not between 1 and 500 then
    raise exception 'invalid_updates: 1 to 500 updates' using errcode = '22023';
  end if;
  update public.calendar_api_tokens set last_used_at = now() where id = v_tok.id;

  perform set_config('pms.actor_type', 'api', true);
  perform set_config('pms.actor_id', 'pricing_tool:' || v_tok.id, true);
  perform set_config('pms.calendar_source', 'pricing_tool', true);

  for u in select * from jsonb_array_elements(p_updates) loop
    begin
      v_listing := (u ->> 'listing_id')::uuid;
    exception when others then
      raise exception 'invalid_updates: listing_id must be a uuid' using errcode = '22023';
    end;
    if not exists (select 1 from public.listings l where l.id = v_listing and l.account_id = v_tok.account_id) then
      raise exception 'listing_not_found: %', v_listing using errcode = 'P0002';
    end if;
    v_changes := u - array['listing_id', 'from', 'to', 'price_cents'];
    if u ? 'price_cents' then
      v_changes := v_changes || jsonb_build_object('price',
        case when jsonb_typeof(u -> 'price_cents') = 'null' then '{"op": "reset"}'::jsonb
             else jsonb_build_object('op', 'set', 'cents', u -> 'price_cents') end);
    end if;
    for r in select * from public.update_calendar(array[v_listing], (u ->> 'from')::date, (u ->> 'to')::date, v_changes) loop
      v_results := v_results || jsonb_build_object('listing_id', r.listing_id, 'nights_changed', r.nights_changed, 'fields', r.fields);
    end loop;
  end loop;

  perform set_config('pms.actor_type', '', true);
  perform set_config('pms.actor_id', '', true);
  perform set_config('pms.calendar_source', '', true);

  return jsonb_build_object(
    'listings', (select count(distinct x ->> 'listing_id') from jsonb_array_elements(v_results) x),
    'nights_changed', (select coalesce(sum((x ->> 'nights_changed')::integer), 0) from jsonb_array_elements(v_results) x),
    'results', v_results);
end;
$$;

-- ---------------------------------------------------------------------------
-- Jobs (CAL-01 horizon, hold expiry)
-- ---------------------------------------------------------------------------

-- Keeps today + max(730, booking window) nights generated for every non-archived root listing.
-- Idempotent and incremental (only nights after each listing's last row). Returns rows added.
create or replace function public.extend_calendar_horizon()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.calendar_days (listing_id, account_id, night)
  select l.id, l.account_id, s.first_night + i
  from public.listings l
  cross join lateral (
    select greatest(
             coalesce((select max(d.night) + 1 from public.calendar_days d where d.listing_id = l.id), (now() at time zone l.timezone)::date),
             (now() at time zone l.timezone)::date) as first_night,
           private.calendar_horizon_end(l) as end_night
  ) s
  cross join lateral generate_series(0, s.end_night - s.first_night - 1) i
  where l.type in ('single', 'multi_parent') and l.status <> 'archived'
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.expire_calendar_holds()
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.expire_holds(null, null)
$$;

-- ---------------------------------------------------------------------------
-- Integrity: hold status machine, append-only change log
-- ---------------------------------------------------------------------------

create or replace function private.calendar_holds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'calendar holds are never deleted; release them instead' using errcode = '42501';
  end if;
  if old.status <> 'active' then
    raise exception 'hold_status: a % hold is final', old.status using errcode = '55000';
  end if;
  if (new.id, new.account_id, new.source_type, new.source_id, new.created_at, new.created_by, new.split_from)
     is distinct from (old.id, old.account_id, old.source_type, old.source_id, old.created_at, old.created_by, old.split_from) then
    raise exception 'hold_status: identity columns of a hold cannot change' using errcode = '55000';
  end if;
  if new.status <> 'active' and new.released_at is null then
    new.released_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger calendar_holds_guard
  before update or delete on public.calendar_holds
  for each row execute function private.calendar_holds_guard();

create or replace function private.calendar_changes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'calendar_changes is append-only' using errcode = '42501';
end;
$$;

create trigger calendar_changes_append_only
  before update or delete on public.calendar_changes
  for each row execute function private.calendar_changes_guard();

create trigger calendar_api_tokens_touch before update on public.calendar_api_tokens
  for each row execute function private.touch_updated_at();

-- X-03 audit. Per-night override edits are audited in calendar_changes (same actor/IP fields).
create trigger audit_calendar_holds after insert or update or delete on public.calendar_holds
  for each row execute function private.audit_row_change();
create trigger audit_calendar_api_tokens after insert or update or delete on public.calendar_api_tokens
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------

alter table public.calendar_days enable row level security;
alter table public.calendar_holds enable row level security;
alter table public.calendar_changes enable row level security;
alter table public.calendar_api_tokens enable row level security;

revoke all on public.calendar_days, public.calendar_holds, public.calendar_changes, public.calendar_api_tokens from anon;
revoke insert, update, delete, truncate on
  public.calendar_days, public.calendar_holds, public.calendar_changes, public.calendar_api_tokens
from authenticated;

create policy calendar_days_select on public.calendar_days
  for select to authenticated
  using (private.can_view_listing_calendar(account_id, listing_id));

create policy calendar_holds_select on public.calendar_holds
  for select to authenticated
  using (private.can_view_listing_calendar(account_id, listing_id));

create policy calendar_changes_select on public.calendar_changes
  for select to authenticated
  using (private.can_view_listing_calendar(account_id, listing_id));

create policy calendar_api_tokens_select on public.calendar_api_tokens
  for select to authenticated
  using (private.has_permission(account_id, 'calendar.manage'));

-- User-facing RPCs (permission checks inside).
revoke execute on function
  public.check_availability(uuid, date, date, integer, uuid),
  public.get_calendar(uuid[], date, date),
  public.quote_stay(uuid, date, date, integer, integer),
  public.get_night_changes(uuid, date),
  public.listing_has_future_bookings(uuid),
  public.listing_future_holds(uuid),
  public.next_arrivals(uuid[]),
  public.block_dates(uuid[], date, date, text, text, boolean),
  public.unblock_dates(uuid[], date, date, boolean),
  public.update_calendar(uuid[], date, date, jsonb, integer[], boolean),
  public.create_pricing_tool_token(uuid, text),
  public.revoke_pricing_tool_token(uuid)
from public, anon;
grant execute on function
  public.check_availability(uuid, date, date, integer, uuid),
  public.get_calendar(uuid[], date, date),
  public.quote_stay(uuid, date, date, integer, integer),
  public.get_night_changes(uuid, date),
  public.listing_has_future_bookings(uuid),
  public.listing_future_holds(uuid),
  public.next_arrivals(uuid[]),
  public.block_dates(uuid[], date, date, text, text, boolean),
  public.unblock_dates(uuid[], date, date, boolean),
  public.update_calendar(uuid[], date, date, jsonb, integer[], boolean),
  public.create_pricing_tool_token(uuid, text),
  public.revoke_pricing_tool_token(uuid)
to authenticated, service_role;

-- System / worker RPCs: service role only. Reservations (step 4) call the hold functions from
-- their own security-definer RPCs.
revoke execute on function
  public.place_hold(uuid, date, date, text, uuid, timestamptz, text, text, boolean, integer),
  public.release_hold(uuid, text),
  public.move_hold(uuid, date, date, uuid),
  public.apply_pricing_tool_updates(text, jsonb),
  public.extend_calendar_horizon(),
  public.expire_calendar_holds()
from public, anon, authenticated;
grant execute on function
  public.place_hold(uuid, date, date, text, uuid, timestamptz, text, text, boolean, integer),
  public.release_hold(uuid, text),
  public.move_hold(uuid, date, date, uuid),
  public.apply_pricing_tool_updates(text, jsonb),
  public.extend_calendar_horizon(),
  public.expire_calendar_holds()
to service_role;

-- These are short OLTP queries over generic plans with pessimistic estimates; JIT compilation
-- would add ~50-150 ms to each call (measured) and never pays off here.
alter function private.calendar_nights(uuid[], date, date, uuid) set jit = off;
alter function private.find_free_unit(public.listings, date, date, uuid, text) set jit = off;
alter function private.stay_rule_failures(public.listings, date, date, integer) set jit = off;
alter function private.place_hold_internal(uuid, date, date, text, uuid, timestamptz, text, text, boolean, integer) set jit = off;
alter function private.expire_holds(uuid[], daterange) set jit = off;
alter function private.log_listing_default_change(public.listings, public.listings, text, date, date) set jit = off;
alter function private.calendar_on_listing_change() set jit = off;
alter function public.check_availability(uuid, date, date, integer, uuid) set jit = off;
alter function public.get_calendar(uuid[], date, date) set jit = off;
alter function public.quote_stay(uuid, date, date, integer, integer) set jit = off;
alter function public.block_dates(uuid[], date, date, text, text, boolean) set jit = off;
alter function public.unblock_dates(uuid[], date, date, boolean) set jit = off;
alter function public.update_calendar(uuid[], date, date, jsonb, integer[], boolean) set jit = off;
alter function public.move_hold(uuid, date, date, uuid) set jit = off;
alter function public.release_hold(uuid, text) set jit = off;
alter function public.extend_calendar_horizon() set jit = off;

revoke execute on all functions in schema private from public;
grant execute on function private.can_view_listing_calendar(uuid, uuid) to authenticated, service_role;

-- Calendar days for listings that existed before this migration.
select public.extend_calendar_horizon();
