-- Step 5 / CAL-09, CAL-10: iCal export and import. Design: docs/plans/step-5-ical.md.
--
--   * ical_exports         private export URL per listing (token hash in private.ical_export_tokens)
--   * ical_feeds           import subscriptions per listing, with the last run's result
--   * ical_feed_events     one row per imported external event; its `ical` hold has source_id = row id
--
-- Availability only changes through the calendar functions (place_hold_internal, release_hold):
-- this module never writes calendar tables itself.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.ical_exports (
  id uuid primary key,
  account_id uuid not null,
  listing_id uuid not null,
  -- AES-256-GCM ciphertext of the token (PMS_ENCRYPTION_KEY, context = id), so the editor can
  -- show the URL again. Lookups use the sha256 hash in private.ical_export_tokens only.
  token_ciphertext text not null check (token_ciphertext like 'v1.%' and length(token_ciphertext) <= 500),
  token_hint text not null check (length(token_hint) between 1 and 8),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (listing_id, account_id) references public.listings (id, account_id)
);

comment on table public.ical_exports is
  'CAL-09: private iCal export URLs. At most one active (not revoked) per listing; rotate = revoke + new row.';

create unique index ical_exports_one_active on public.ical_exports (listing_id) where revoked_at is null;
create index ical_exports_account_idx on public.ical_exports (account_id);

create table private.ical_export_tokens (
  export_id uuid primary key references public.ical_exports (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  last_accessed_at timestamptz
);
alter table private.ical_export_tokens enable row level security;

create table public.ical_feeds (
  id uuid primary key,
  account_id uuid not null,
  listing_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  -- Feed URLs embed the other channel's secret (X-15): stored encrypted (context = id).
  url_ciphertext text not null check (url_ciphertext like 'v1.%' and length(url_ciphertext) <= 4000),
  url_hash text not null check (url_hash ~ '^[0-9a-f]{64}$'),
  url_display text not null check (length(url_display) <= 300),
  active boolean not null default true,
  -- Last run (CAL-10 "last import result and errors").
  status text not null default 'pending' check (status in ('pending', 'ok', 'conflict', 'error')),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 1000),
  events_imported integer not null default 0,
  last_result jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  etag text check (etag is null or length(etag) <= 500),
  last_modified text check (last_modified is null or length(last_modified) <= 100),
  consecutive_failures integer not null default 0,
  next_run_at timestamptz not null default now(),
  locked_until timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (id, account_id),
  constraint ical_feeds_removed check (active = (removed_at is null)),
  foreign key (listing_id, account_id) references public.listings (id, account_id)
);

comment on table public.ical_feeds is
  'CAL-10: external iCal feeds imported into a listing every 15 minutes. Removed feeds are kept (active = false).';

create unique index ical_feeds_unique_url on public.ical_feeds (listing_id, url_hash) where active;
create index ical_feeds_due_idx on public.ical_feeds (next_run_at) where active;
create index ical_feeds_listing_idx on public.ical_feeds (listing_id, created_at);
create index ical_feeds_account_idx on public.ical_feeds (account_id);

create table public.ical_feed_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  feed_id uuid not null,
  listing_id uuid not null,
  uid text not null check (length(uid) between 1 and 1000),
  check_in date not null,
  check_out date not null,
  hold_id uuid references public.calendar_holds (id),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- Exclusive holds (reservations, owner stays, quotes) on the same nights, from the last run.
  conflicts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint ical_feed_events_dates check (check_out > check_in and check_out - check_in <= 1100),
  foreign key (feed_id, account_id) references public.ical_feeds (id, account_id),
  foreign key (listing_id, account_id) references public.listings (id, account_id)
);

comment on table public.ical_feed_events is
  'CAL-10: imported external events (uid + nights) and their calendar hold. Never deleted; active -> removed.';

create unique index ical_feed_events_active_uid on public.ical_feed_events (feed_id, uid) where status = 'active';
create index ical_feed_events_feed_idx on public.ical_feed_events (feed_id, check_in);
create index ical_feed_events_account_idx on public.ical_feed_events (account_id);

-- ---------------------------------------------------------------------------
-- Integrity, audit, events
-- ---------------------------------------------------------------------------

create or replace function private.ical_feed_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ical feed events are never deleted' using errcode = '42501';
  end if;
  if old.status = 'removed' then
    raise exception 'ical_feed_event: a removed event is final' using errcode = '55000';
  end if;
  if (new.id, new.account_id, new.feed_id, new.listing_id, new.uid) is distinct from (old.id, old.account_id, old.feed_id, old.listing_id, old.uid) then
    raise exception 'ical_feed_event: identity columns cannot change' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger ical_feed_events_guard before update or delete on public.ical_feed_events
  for each row execute function private.ical_feed_events_guard();

create or replace function private.ical_rows_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are never deleted', tg_table_name using errcode = '42501';
end;
$$;

create trigger ical_feeds_no_delete before delete on public.ical_feeds
  for each row execute function private.ical_rows_no_delete();
create trigger ical_exports_no_delete before delete on public.ical_exports
  for each row execute function private.ical_rows_no_delete();

-- X-03. Feeds: settings changes only; the 15-minute run state is reported on the feed and in
-- ical_feed.synced / ical_feed.sync_failed events, and every hold change is audited itself.
create trigger audit_ical_exports after insert or update on public.ical_exports
  for each row execute function private.audit_row_change('token_ciphertext');
create trigger audit_ical_feeds_insert after insert on public.ical_feeds
  for each row execute function private.audit_row_change('url_ciphertext');
create trigger audit_ical_feeds_update after update on public.ical_feeds
  for each row
  when ((old.name, old.url_hash, old.url_display, old.active, old.removed_at)
        is distinct from (new.name, new.url_hash, new.url_display, new.active, new.removed_at))
  execute function private.audit_row_change('url_ciphertext');
create trigger audit_ical_feed_events after insert or update on public.ical_feed_events
  for each row execute function private.audit_row_change();

-- X-04: ical_export.created / .updated, ical_feed.created / .updated (settings and removal).
create trigger events_ical_exports after insert or update on public.ical_exports
  for each row execute function private.emit_row_event('ical_export', 'token_ciphertext');
create trigger events_ical_feeds_insert after insert on public.ical_feeds
  for each row execute function private.emit_row_event('ical_feed', 'url_ciphertext', 'etag', 'last_modified', 'locked_until');
create trigger events_ical_feeds_update after update on public.ical_feeds
  for each row
  when ((old.name, old.url_hash, old.url_display, old.active, old.removed_at)
        is distinct from (new.name, new.url_hash, new.url_display, new.active, new.removed_at))
  execute function private.emit_row_event('ical_feed', 'url_ciphertext', 'etag', 'last_modified', 'locked_until');

-- ---------------------------------------------------------------------------
-- Export (CAL-09)
-- ---------------------------------------------------------------------------

-- Busy ranges [date_from, date_to) of a listing: nights with a hold (reservation, quote, owner
-- stay, manual or iCal block), preparation time or default closed. Advance notice and booking
-- window are booking rules each channel applies itself. A multi-unit parent is busy when it is
-- blocked itself or no active sub-unit is free.
create or replace function private.ical_busy_ranges(p_listing public.listings, p_from date, p_to date)
returns table (date_from date, date_to date)
language sql
stable
security definer
set search_path = ''
as $$
  with units as (
    select coalesce(array_agg(c.id), '{}') as ids
    from public.listings c
    where p_listing.type = 'multi_parent' and c.parent_id = p_listing.id and c.status = 'active'
  ),
  n as materialized (
    select n.listing_id, n.night,
           exists (select 1 from jsonb_array_elements(n.reasons) r
                   where r ->> 'reason' not in ('advance_notice', 'booking_window')) as busy
    from units u
    cross join lateral private.calendar_nights(array[p_listing.id] || u.ids, p_from, p_to) n
  ),
  free as (
    select n.night from n where n.listing_id <> p_listing.id and not n.busy group by n.night
  ),
  busy as (
    select p.night from n p
    where p.listing_id = p_listing.id
      and (p.busy or (p_listing.type = 'multi_parent' and p.night not in (select f.night from free f)))
  ),
  grp as (
    select b.night, b.night - (row_number() over (order by b.night))::integer as g from busy b
  )
  select min(g.night), max(g.night) + 1 from grp g group by g.g order by 1
$$;

-- Creates (or rotates) the listing's export URL. The app generates the token, encrypts it and
-- sends its sha256; the previous URL stops working in the same transaction.
create or replace function public.create_ical_export(
  p_export_id uuid,
  p_listing_id uuid,
  p_token_hash text,
  p_token_ciphertext text,
  p_token_hint text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'calendar.manage');
begin
  if v_l.type = 'complex' then
    raise exception 'listing_not_bookable: a complex has no calendar' using errcode = 'P0001';
  end if;
  if p_export_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  update public.ical_exports set revoked_at = now(), updated_at = now()
  where listing_id = v_l.id and revoked_at is null;
  insert into public.ical_exports (id, account_id, listing_id, token_ciphertext, token_hint, created_by)
  values (p_export_id, v_l.account_id, v_l.id, p_token_ciphertext, p_token_hint, auth.uid());
  insert into private.ical_export_tokens (export_id, token_hash) values (p_export_id, p_token_hash);
  return p_export_id;
end;
$$;

create or replace function public.revoke_ical_export(p_export_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.ical_exports;
begin
  select * into v from public.ical_exports where id = p_export_id for update;
  if not found then
    raise exception 'ical_export_not_found' using errcode = 'P0002';
  end if;
  perform private.calendar_authorize(v.listing_id, 'calendar.manage');
  if v.revoked_at is null then
    update public.ical_exports set revoked_at = now(), updated_at = now() where id = v.id;
  end if;
end;
$$;

-- When the editor last saw each export URL fetched (the access time lives with the hash).
create or replace function public.ical_export_last_access(p_export_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.ical_exports;
begin
  select * into v from public.ical_exports where id = p_export_id;
  if not found then
    return null;
  end if;
  perform private.calendar_authorize(v.listing_id, 'calendar.manage');
  return (select t.last_accessed_at from private.ical_export_tokens t where t.export_id = v.id);
end;
$$;

-- The public .ics route: token → busy ranges. Callable by anon (the 256-bit token is the
-- credential); returns null for unknown or revoked tokens. Availability only: dates, no names,
-- codes, notes or sources.
create or replace function public.ical_export_calendar(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export public.ical_exports;
  v_l public.listings;
  v_r public.listings;
  v_today date;
  v_hash text;
begin
  if p_token is null or p_token !~ '^pmsical_[A-Za-z0-9_-]{20,100}$' then
    return null;
  end if;
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  select e.* into v_export
  from private.ical_export_tokens t
  join public.ical_exports e on e.id = t.export_id
  where t.token_hash = v_hash and e.revoked_at is null;
  if not found then
    return null;
  end if;
  select * into v_l from public.listings where id = v_export.listing_id;
  v_r := private.rules_listing(v_l);
  v_today := (now() at time zone v_r.timezone)::date;

  update private.ical_export_tokens set last_accessed_at = now()
  where export_id = v_export.id and (last_accessed_at is null or last_accessed_at < now() - interval '5 minutes');

  -- The window starts 90 days back so an ongoing block keeps its first night (and its UID).
  return jsonb_build_object(
    'listing_key', v_l.id,
    'timezone', v_r.timezone,
    'from', v_today - 90,
    'to', v_today + 730,
    'ranges', coalesce((
      select jsonb_agg(jsonb_build_object('from', b.date_from, 'to', b.date_to) order by b.date_from)
      from private.ical_busy_ranges(v_l, v_today - 90, v_today + 730) b
    ), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Import feeds (CAL-10)
-- ---------------------------------------------------------------------------

create or replace function public.add_ical_feed(
  p_feed_id uuid,
  p_listing_id uuid,
  p_name text,
  p_url_ciphertext text,
  p_url_hash text,
  p_url_display text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'calendar.manage');
begin
  if v_l.type = 'complex' then
    raise exception 'listing_not_bookable: a complex has no calendar' using errcode = 'P0001';
  end if;
  if v_l.status = 'archived' then
    raise exception 'listing_not_bookable: the listing is archived' using errcode = 'P0001';
  end if;
  if (select count(*) from public.ical_feeds f where f.listing_id = v_l.id and f.active) >= 20 then
    raise exception 'too_many_feeds: at most 20 iCal feeds per listing' using errcode = '22023';
  end if;
  if exists (select 1 from public.ical_feeds f where f.listing_id = v_l.id and f.active and f.url_hash = p_url_hash) then
    raise exception 'ical_feed_exists: this listing already imports that URL' using errcode = '23505';
  end if;
  insert into public.ical_feeds (id, account_id, listing_id, name, url_ciphertext, url_hash, url_display, created_by)
  values (p_feed_id, v_l.account_id, v_l.id, btrim(p_name), p_url_ciphertext, p_url_hash, p_url_display, auth.uid());
  return p_feed_id;
end;
$$;

-- Loads and locks a feed, checking the caller may manage its listing's calendar.
create or replace function private.ical_feed_for_update(p_feed_id uuid)
returns public.ical_feeds
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.ical_feeds;
begin
  select * into v from public.ical_feeds where id = p_feed_id for update;
  if not found then
    raise exception 'ical_feed_not_found: %', p_feed_id using errcode = 'P0002';
  end if;
  perform private.calendar_authorize(v.listing_id, 'calendar.manage');
  return v;
end;
$$;

-- Removing a feed releases every block it imported (the feed row and its events are kept).
create or replace function public.remove_ical_feed(p_feed_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feed public.ical_feeds := private.ical_feed_for_update(p_feed_id);
  e public.ical_feed_events;
  v_count integer := 0;
begin
  if not v_feed.active then
    return 0;
  end if;
  for e in select * from public.ical_feed_events where feed_id = v_feed.id and status = 'active' order by check_in for update loop
    if e.hold_id is not null then
      perform public.release_hold(e.hold_id, 'ical feed removed');
    end if;
    update public.ical_feed_events set status = 'removed', removed_at = now() where id = e.id;
    v_count := v_count + 1;
  end loop;
  update public.ical_feeds
  set active = false, removed_at = now(), updated_at = now(), locked_until = null, events_imported = 0, conflicts = '[]'::jsonb
  where id = v_feed.id;
  return v_count;
end;
$$;

-- Exclusive holds (reservations, owner stays, quotes) on the event's nights: on the listing
-- itself, or on any sub-unit when the feed belongs to a multi-unit parent.
create or replace function private.ical_event_conflicts(p_listing public.listings, p_check_in date, p_check_out date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'hold_id', h.id, 'source_type', h.source_type, 'source_id', h.source_id, 'code', r.code,
           'unit_id', h.listing_id, 'check_in', h.check_in, 'check_out', h.check_out)
         order by h.check_in, h.id), '[]'::jsonb)
  from public.calendar_holds h
  left join public.reservations r on r.id = h.source_id and h.source_type in ('reservation', 'owner_stay')
  where h.status = 'active' and h.exclusive
    and (h.expires_at is null or h.expires_at > now())
    and h.nights && daterange(p_check_in, p_check_out)
    and (h.listing_id = p_listing.id
         or (p_listing.type = 'multi_parent' and h.listing_id in (select c.id from public.listings c where c.parent_id = p_listing.id)))
$$;

-- CAL-10 sync: diffs the feed's desired blocks against its imported events in one transaction.
--   p_events: [{uid, check_in, check_out}] (normalised in src/lib/ical/normalize.ts), or null
--             when the feed answered 304 Not Modified (everything stays).
--   p_meta:   {etag, last_modified, skipped: {...}}
-- New uid → place an `ical` hold; changed dates → release + place (iCal holds are not movable);
-- vanished uid → release. Overlaps with reservations are recorded as conflicts, never resolved
-- by deleting anything. Returns the run result.
create or replace function public.apply_ical_feed_sync(p_feed_id uuid, p_events jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feed public.ical_feeds := private.ical_feed_for_update(p_feed_id);
  v_l public.listings;
  v_note text;
  x record;
  e public.ical_feed_events;
  v_event_id uuid;
  v_hold uuid;
  v_placed integer := 0;
  v_moved integer := 0;
  v_released integer := 0;
  v_healed integer := 0;
  v_conflicts jsonb;
  v_status text;
  v_error text;
  v_count integer;
  v_result jsonb;
begin
  if not v_feed.active then
    raise exception 'ical_feed_removed: %', p_feed_id using errcode = 'P0001';
  end if;
  select * into v_l from public.listings where id = v_feed.listing_id;
  v_note := left('iCal: ' || v_feed.name, 1000);

  if p_events is not null then
    if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 5000 then
      raise exception 'invalid_events: an array of at most 5000 events' using errcode = '22023';
    end if;
    begin
      perform 1
      from jsonb_to_recordset(p_events) as t(uid text, check_in date, check_out date)
      where t.uid is null or length(t.uid) not between 1 and 1000 or t.check_in is null or t.check_out is null
         or t.check_out <= t.check_in or t.check_out - t.check_in > 1100
      limit 1;
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      raise exception 'invalid_events: check_in and check_out must be dates' using errcode = '22023';
    end;
    if found then
      raise exception 'invalid_events: uid of 1-1000 characters, check_out 1 to 1100 nights after check_in' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_events) j group by j ->> 'uid' having count(*) > 1) then
      raise exception 'invalid_events: duplicate uid' using errcode = '22023';
    end if;

    -- Vanished (or cancelled) events: free their nights.
    for e in
      select * from public.ical_feed_events ev
      where ev.feed_id = v_feed.id and ev.status = 'active'
        and not exists (select 1 from jsonb_array_elements(p_events) j where j ->> 'uid' = ev.uid)
      order by ev.check_in
      for update
    loop
      if e.hold_id is not null then
        perform public.release_hold(e.hold_id, 'ical event removed from feed');
      end if;
      update public.ical_feed_events set status = 'removed', removed_at = now(), conflicts = '[]'::jsonb where id = e.id;
      v_released := v_released + 1;
    end loop;

    for x in
      select i.uid, i.check_in, i.check_out, ev.id as event_id, ev.check_in as old_in, ev.check_out as old_out,
             ev.hold_id, h.status as hold_status
      from jsonb_to_recordset(p_events) as i(uid text, check_in date, check_out date)
      left join public.ical_feed_events ev on ev.feed_id = v_feed.id and ev.uid = i.uid and ev.status = 'active'
      left join public.calendar_holds h on h.id = ev.hold_id
      order by i.check_in, i.uid
    loop
      if x.event_id is null then
        insert into public.ical_feed_events (account_id, feed_id, listing_id, uid, check_in, check_out)
        values (v_feed.account_id, v_feed.id, v_feed.listing_id, x.uid, x.check_in, x.check_out)
        returning id into v_event_id;
        v_hold := private.place_hold_internal(v_feed.listing_id, x.check_in, x.check_out, 'ical', v_event_id,
                                              null, v_note, null, false, 1);
        update public.ical_feed_events set hold_id = v_hold where id = v_event_id;
        v_placed := v_placed + 1;
      elsif (x.old_in, x.old_out) is distinct from (x.check_in, x.check_out) then
        if x.hold_status = 'active' then
          perform public.release_hold(x.hold_id, 'ical event dates changed');
        end if;
        v_hold := private.place_hold_internal(v_feed.listing_id, x.check_in, x.check_out, 'ical', x.event_id,
                                              null, v_note, null, false, 1);
        update public.ical_feed_events set check_in = x.check_in, check_out = x.check_out, hold_id = v_hold where id = x.event_id;
        v_moved := v_moved + 1;
      elsif x.hold_status is distinct from 'active' then
        -- The block was lost (e.g. released by hand): put it back, the feed is the source.
        v_hold := private.place_hold_internal(v_feed.listing_id, x.check_in, x.check_out, 'ical', x.event_id,
                                              null, v_note, null, false, 1);
        update public.ical_feed_events set hold_id = v_hold where id = x.event_id;
        v_healed := v_healed + 1;
      end if;
    end loop;
  end if;

  -- Conflicts with bookings, per event and for the feed.
  update public.ical_feed_events ev
  set conflicts = c.conflicts
  from (
    select ev2.id, private.ical_event_conflicts(v_l, ev2.check_in, ev2.check_out) as conflicts
    from public.ical_feed_events ev2
    where ev2.feed_id = v_feed.id and ev2.status = 'active'
  ) c
  where ev.id = c.id and ev.conflicts is distinct from c.conflicts;

  select coalesce(jsonb_agg(jsonb_build_object('event_id', ev.id, 'uid', ev.uid, 'check_in', ev.check_in,
                                               'check_out', ev.check_out, 'with', ev.conflicts)
                            order by ev.check_in, ev.uid), '[]'::jsonb),
         (select count(*)::integer from public.ical_feed_events a where a.feed_id = v_feed.id and a.status = 'active')
  into v_conflicts, v_count
  from public.ical_feed_events ev
  where ev.feed_id = v_feed.id and ev.status = 'active' and ev.conflicts <> '[]'::jsonb;

  if jsonb_array_length(v_conflicts) > 0 then
    v_status := 'conflict';
    select 'Overlaps ' || string_agg(distinct coalesce(c ->> 'code', replace(c ->> 'source_type', '_', ' ')), ', ')
           || '. The external booking is blocked here too; move or cancel one of them.'
    into v_error
    from jsonb_array_elements(v_conflicts) f
    cross join lateral jsonb_array_elements(f -> 'with') c;
  else
    v_status := 'ok';
  end if;

  v_result := jsonb_build_object(
    'status', v_status, 'events', v_count, 'placed', v_placed, 'moved', v_moved, 'released', v_released,
    'restored', v_healed, 'unchanged', p_events is null, 'conflicts', jsonb_array_length(v_conflicts),
    'skipped', coalesce(p_meta -> 'skipped', '{}'::jsonb));

  update public.ical_feeds
  set status = v_status,
      last_run_at = now(),
      last_success_at = now(),
      last_error = left(v_error, 1000),
      events_imported = v_count,
      last_result = v_result,
      conflicts = v_conflicts,
      etag = case when p_events is null then etag else left(nullif(p_meta ->> 'etag', ''), 500) end,
      last_modified = case when p_events is null then last_modified else left(nullif(p_meta ->> 'last_modified', ''), 100) end,
      consecutive_failures = 0,
      next_run_at = now() + interval '15 minutes',
      locked_until = null
  where id = v_feed.id;

  if v_placed + v_moved + v_released + v_healed > 0 or v_status <> v_feed.status or v_conflicts <> v_feed.conflicts then
    perform private.emit_event(v_feed.account_id, 'ical_feed.synced', 'ical_feed', v_feed.id::text,
      jsonb_build_object('feed_id', v_feed.id, 'listing_id', v_feed.listing_id) || v_result);
  end if;
  return v_result;
end;
$$;

-- A failed run (fetch or parse error) keeps every imported block (business rule) and backs off:
-- 15 minutes × consecutive failures, at most an hour.
create or replace function public.record_ical_feed_failure(p_feed_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feed public.ical_feeds := private.ical_feed_for_update(p_feed_id);
  v_error text := left(coalesce(nullif(btrim(p_error), ''), 'Import failed'), 1000);
begin
  if not v_feed.active then
    return;
  end if;
  update public.ical_feeds
  set status = 'error',
      last_run_at = now(),
      last_error = v_error,
      consecutive_failures = consecutive_failures + 1,
      next_run_at = now() + interval '15 minutes' * least(consecutive_failures + 1, 4),
      locked_until = null
  where id = v_feed.id;
  if v_feed.status <> 'error' or v_feed.last_error is distinct from v_error then
    perform private.emit_event(v_feed.account_id, 'ical_feed.sync_failed', 'ical_feed', v_feed.id::text,
      jsonb_build_object('feed_id', v_feed.id, 'listing_id', v_feed.listing_id, 'error', v_error,
                         'consecutive_failures', v_feed.consecutive_failures + 1));
  end if;
end;
$$;

-- Worker: claims up to p_limit due feeds with a lease, so overlapping runs never sync one feed
-- twice. "Due" includes the next 2 minutes, so a 15-minute schedule never skips a run.
create or replace function public.claim_ical_feeds(p_limit integer default 20, p_lease_seconds integer default 120)
returns table (feed_id uuid, account_id uuid, listing_id uuid, url_ciphertext text, etag text, last_modified text, timezone text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select f.id
    from public.ical_feeds f
    join public.listings l on l.id = f.listing_id
    where f.active and l.status <> 'archived'
      and f.next_run_at <= now() + interval '2 minutes'
      and (f.locked_until is null or f.locked_until < now())
    order by f.next_run_at
    limit greatest(least(coalesce(p_limit, 20), 200), 1)
    for update of f skip locked
  )
  update public.ical_feeds f
  set locked_until = now() + make_interval(secs => greatest(least(coalesce(p_lease_seconds, 120), 900), 10))
  from due, public.listings l
  left join public.listings p on p.id = l.parent_id
  where f.id = due.id and l.id = f.listing_id
  returning f.id, f.account_id, f.listing_id, f.url_ciphertext, f.etag, f.last_modified, coalesce(p.timezone, l.timezone);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------

alter table public.ical_exports enable row level security;
alter table public.ical_feeds enable row level security;
alter table public.ical_feed_events enable row level security;

revoke all on public.ical_exports, public.ical_feeds, public.ical_feed_events from anon;
revoke insert, update, delete, truncate on public.ical_exports, public.ical_feeds, public.ical_feed_events from authenticated;

create policy ical_exports_select on public.ical_exports
  for select to authenticated
  using (private.has_permission(account_id, 'calendar.manage') and private.can_view_listing_calendar(account_id, listing_id));

create policy ical_feeds_select on public.ical_feeds
  for select to authenticated
  using (private.has_permission(account_id, 'calendar.manage') and private.can_view_listing_calendar(account_id, listing_id));

-- Feed events explain `ical_import` blocks on the calendar, so calendar viewers may read them.
create policy ical_feed_events_select on public.ical_feed_events
  for select to authenticated
  using (private.can_view_listing_calendar(account_id, listing_id));

-- Settings RPCs for signed-in users (calendar.manage is checked inside) and the service role.
revoke execute on function
  public.create_ical_export(uuid, uuid, text, text, text),
  public.revoke_ical_export(uuid),
  public.ical_export_last_access(uuid),
  public.add_ical_feed(uuid, uuid, text, text, text, text),
  public.remove_ical_feed(uuid),
  public.apply_ical_feed_sync(uuid, jsonb, jsonb),
  public.record_ical_feed_failure(uuid, text)
from public, anon;
grant execute on function
  public.create_ical_export(uuid, uuid, text, text, text),
  public.revoke_ical_export(uuid),
  public.ical_export_last_access(uuid),
  public.add_ical_feed(uuid, uuid, text, text, text, text),
  public.remove_ical_feed(uuid),
  public.apply_ical_feed_sync(uuid, jsonb, jsonb),
  public.record_ical_feed_failure(uuid, text)
to authenticated, service_role;

-- The public export route: anyone holding a token.
revoke execute on function public.ical_export_calendar(text) from public;
grant execute on function public.ical_export_calendar(text) to anon, authenticated, service_role;

-- Worker only.
revoke execute on function public.claim_ical_feeds(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ical_feeds(integer, integer) to service_role;

alter function private.ical_busy_ranges(public.listings, date, date) set jit = off;
alter function public.ical_export_calendar(text) set jit = off;
alter function public.apply_ical_feed_sync(uuid, jsonb, jsonb) set jit = off;

revoke execute on all functions in schema private from public;
