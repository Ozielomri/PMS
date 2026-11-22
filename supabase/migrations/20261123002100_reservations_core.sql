-- Step 4 / RES-01 … RES-04, RES-06 … RES-14, RES-16 … RES-19: guests, reservations, status
-- machine, money (lines, payments, balances), activity, notes and files, settings, saved views.
-- Design: docs/plans/step-4-reservations.md. Every availability change goes through the Calendar
-- API (place_hold / move_hold / release_hold / set_hold_expiry); this module never writes
-- calendar tables.

create type public.reservation_status as enum ('inquiry', 'reserved', 'confirmed', 'declined', 'expired', 'closed', 'canceled');
create type public.stay_status as enum ('upcoming', 'checked_in', 'checked_out', 'no_show');

-- Sources. booking_com / airbnb / vrbo are channels: their bookings are changed on the channel.
create or replace function private.is_channel_source(p_source text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_source in ('booking_com', 'airbnb', 'vrbo')
$$;

-- ---------------------------------------------------------------------------
-- Guests (RES-12)
-- ---------------------------------------------------------------------------

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text check (last_name is null or length(last_name) <= 100),
  email text check (email is null or (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254)),
  phone text check (phone is null or length(phone) <= 40),
  language text check (language is null or language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  nationality char(2) check (nationality is null or nationality ~ '^[A-Z]{2}$'),
  notes text check (notes is null or length(notes) <= 5000),
  tags text[] not null default '{}',
  merged_into_id uuid,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, account_id),
  foreign key (merged_into_id, account_id) references public.guests (id, account_id)
);

create index guests_account_name_idx on public.guests (account_id, lower(last_name), lower(first_name));
create index guests_account_email_idx on public.guests (account_id, lower(email)) where email is not null;
create index guests_account_phone_idx on public.guests (account_id, phone) where phone is not null;

create or replace function private.guest_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(lower(btrim(new.email)), '');
  new.phone := nullif(btrim(new.phone), '');
  new.first_name := btrim(new.first_name);
  new.last_name := nullif(btrim(new.last_name), '');
  new.tags := private.normalize_tags(new.tags);
  if tg_op = 'UPDATE' and new.account_id <> old.account_id then
    raise exception 'guest account cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guests_rules before insert or update on public.guests
  for each row execute function private.guest_rules();
create trigger guests_touch before update on public.guests
  for each row execute function private.touch_updated_at();
create trigger audit_guests after insert or update or delete on public.guests
  for each row execute function private.audit_row_change();
create trigger events_guests after insert or update on public.guests
  for each row execute function private.emit_row_event('guest');

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  code text not null check (code ~ '^R[0-9A-Z]{7}$'),
  kind text not null default 'guest' check (kind in ('guest', 'owner_stay')),
  status public.reservation_status not null,
  stay_status public.stay_status,
  -- What was booked (a multi-unit parent, a unit or a sub-unit) and the unit actually held.
  listing_id uuid not null,
  unit_id uuid,
  guest_id uuid,
  source text not null default 'direct'
    check (source in ('direct', 'phone', 'email', 'walk_in', 'website', 'booking_com', 'airbnb', 'vrbo', 'owner', 'other')),
  channel_reservation_id text check (channel_reservation_id is null or length(channel_reservation_id) between 1 and 200),
  check_in date not null,
  check_out date not null,
  nights integer generated always as (check_out - check_in) stored,
  adults integer not null default 1 check (adults between 0 and 100),
  children integer not null default 0 check (children between 0 and 100),
  infants integer not null default 0 check (infants between 0 and 100),
  pets integer not null default 0 check (pets between 0 and 20),
  -- Snapshots at booking time
  currency char(3) not null default 'USD',
  cancellation_policy text not null default 'moderate',
  approval_deadline timestamptz,
  hold_id uuid references public.calendar_holds (id),
  eta time,
  etd time,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  canceled_at timestamptz,
  canceled_by text check (canceled_by is null or canceled_by in ('host', 'guest', 'channel')),
  status_reason text check (status_reason is null or length(status_reason) <= 1000),
  refund_percent integer check (refund_percent is null or refund_percent between 0 and 100),
  tags text[] not null default '{}',
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, code),
  unique (id, account_id),
  unique (account_id, source, channel_reservation_id),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  foreign key (unit_id, account_id) references public.listings (id, account_id),
  foreign key (guest_id, account_id) references public.guests (id, account_id),
  constraint reservations_dates check (check_out > check_in and check_out - check_in <= 365),
  constraint reservations_stay_status check ((status = 'confirmed') = (stay_status is not null)),
  constraint reservations_guest_required check (kind = 'owner_stay' or guest_id is not null),
  constraint reservations_owner_stay check (kind <> 'owner_stay' or (status in ('confirmed', 'canceled') and source = 'owner')),
  constraint reservations_channel_code check (not private.is_channel_source(source) or channel_reservation_id is not null)
);

comment on table public.reservations is
  'RES: bookings. Never deleted; status machine enforced by trigger; money in reservation_lines / reservation_payments.';

create index reservations_account_check_in_idx on public.reservations (account_id, check_in);
create index reservations_account_check_out_idx on public.reservations (account_id, check_out);
create index reservations_account_status_idx on public.reservations (account_id, status, check_in);
create index reservations_listing_idx on public.reservations (listing_id, check_in);
create index reservations_unit_idx on public.reservations (unit_id, check_in) where unit_id is not null;
create index reservations_guest_idx on public.reservations (guest_id);
create index reservations_hold_idx on public.reservations (hold_id) where hold_id is not null;

-- RES-03 status machine (also mirrored in src/lib/reservations/status.ts; parity is tested).
create or replace function private.reservation_transition_allowed(p_from public.reservation_status, p_to public.reservation_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from::text, p_to::text) in (
    ('inquiry', 'reserved'), ('inquiry', 'confirmed'), ('inquiry', 'closed'),
    ('reserved', 'confirmed'), ('reserved', 'declined'), ('reserved', 'expired'),
    ('confirmed', 'canceled')
  )
$$;

create or replace function private.stay_transition_allowed(p_from public.stay_status, p_to public.stay_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from::text, p_to::text) in (('upcoming', 'checked_in'), ('upcoming', 'no_show'), ('checked_in', 'checked_out'))
$$;

create or replace function private.reservation_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  new.tags := private.normalize_tags(new.tags);
  if tg_op = 'INSERT' then
    if new.status not in ('inquiry', 'reserved', 'confirmed') then
      raise exception 'reservation_status_invalid: a reservation starts as inquiry, reserved or confirmed' using errcode = '22023';
    end if;
    new.stay_status := case when new.status = 'confirmed' then 'upcoming'::public.stay_status end;
    return new;
  end if;

  if new.account_id <> old.account_id or new.id <> old.id or new.code <> old.code or new.kind <> old.kind
     or new.created_at <> old.created_at then
    raise exception 'reservation identity cannot change' using errcode = '42501';
  end if;

  if old.status in ('declined', 'expired', 'closed', 'canceled') then
    -- Final: only tags and a guest merge may change.
    v_old := to_jsonb(old) - array['tags', 'guest_id', 'updated_at', 'nights'];
    v_new := to_jsonb(new) - array['tags', 'guest_id', 'updated_at', 'nights'];
    if v_old <> v_new then
      raise exception 'reservation_final: a % reservation can only change tags and notes', old.status using errcode = '55000';
    end if;
    if new.guest_id is distinct from old.guest_id and coalesce(current_setting('pms.guest_merge', true), '') <> 'on' then
      raise exception 'reservation_final: a % reservation can only change tags and notes', old.status using errcode = '55000';
    end if;
    return new;
  end if;

  if new.status <> old.status then
    if not private.reservation_transition_allowed(old.status, new.status) then
      raise exception 'reservation_transition_invalid: % to % is not allowed', old.status, new.status using errcode = '55000';
    end if;
    if new.status = 'confirmed' then
      new.stay_status := 'upcoming';
    elsif new.status <> 'confirmed' then
      new.stay_status := null;
    end if;
    if new.status = 'canceled' then
      new.canceled_at := coalesce(new.canceled_at, now());
    end if;
  elsif new.stay_status is distinct from old.stay_status then
    if old.status <> 'confirmed' or not private.stay_transition_allowed(old.stay_status, new.stay_status) then
      raise exception 'stay_status_transition_invalid: % to %', old.stay_status, new.stay_status using errcode = '55000';
    end if;
    if new.stay_status = 'checked_in' then
      new.checked_in_at := coalesce(new.checked_in_at, now());
    elsif new.stay_status = 'checked_out' then
      new.checked_out_at := coalesce(new.checked_out_at, now());
    end if;
  end if;
  return new;
end;
$$;

create trigger reservations_rules before insert or update on public.reservations
  for each row execute function private.reservation_rules();
create trigger reservations_touch before update on public.reservations
  for each row execute function private.touch_updated_at();
create trigger audit_reservations after insert or update or delete on public.reservations
  for each row execute function private.audit_row_change();

create or replace function private.reservations_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'reservations are never deleted' using errcode = '42501';
end;
$$;

create trigger reservations_never_deleted before delete on public.reservations
  for each row execute function private.reservations_no_delete();

-- RES-19 events
create or replace function private.emit_reservation_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.emit_event(new.account_id, 'reservation.created', 'reservation', new.id::text, jsonb_build_object('record', v_new));
    return null;
  end if;
  if new.status <> old.status then
    perform private.emit_event(new.account_id, 'reservation.status_changed', 'reservation', new.id::text,
      jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.status_reason, 'record', v_new));
  end if;
  if (new.check_in, new.check_out, new.listing_id, new.unit_id) is distinct from (old.check_in, old.check_out, old.listing_id, old.unit_id) then
    perform private.emit_event(new.account_id, 'reservation.dates_changed', 'reservation', new.id::text,
      jsonb_build_object(
        'old', jsonb_build_object('check_in', old.check_in, 'check_out', old.check_out, 'listing_id', old.listing_id, 'unit_id', old.unit_id),
        'new', jsonb_build_object('check_in', new.check_in, 'check_out', new.check_out, 'listing_id', new.listing_id, 'unit_id', new.unit_id),
        'record', v_new));
  end if;
  v_changes := private.row_diff(
    to_jsonb(old) - array['status', 'stay_status', 'check_in', 'check_out', 'nights', 'listing_id', 'unit_id', 'hold_id', 'updated_at', 'approval_deadline', 'status_reason', 'canceled_at', 'canceled_by', 'refund_percent', 'checked_in_at', 'checked_out_at'],
    v_new - array['status', 'stay_status', 'check_in', 'check_out', 'nights', 'listing_id', 'unit_id', 'hold_id', 'updated_at', 'approval_deadline', 'status_reason', 'canceled_at', 'canceled_by', 'refund_percent', 'checked_in_at', 'checked_out_at']);
  if v_changes <> '{}'::jsonb or (new.stay_status is distinct from old.stay_status and new.status = old.status) then
    perform private.emit_event(new.account_id, 'reservation.updated', 'reservation', new.id::text,
      jsonb_build_object('changes', v_changes || case when new.stay_status is distinct from old.stay_status
        then jsonb_build_object('stay_status', jsonb_build_object('old', old.stay_status, 'new', new.stay_status)) else '{}'::jsonb end,
        'record', v_new));
  end if;
  return null;
end;
$$;

create trigger events_reservations after insert or update on public.reservations
  for each row execute function private.emit_reservation_events();

-- ---------------------------------------------------------------------------
-- Money (RES-08, RES-09, RES-10)
-- ---------------------------------------------------------------------------

create table public.reservation_lines (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  reservation_id uuid not null,
  kind text not null check (kind in ('accommodation', 'extra_guest_fee', 'cleaning_fee', 'pet_fee', 'discount',
                                     'extra', 'adjustment', 'cancellation', 'commission')),
  label text not null check (length(btrim(label)) between 1 and 200),
  quantity integer not null default 1,
  unit_amount_cents bigint,
  -- Guest-facing amount (commission: what the host pays the channel, not charged to the guest).
  amount_cents bigint not null,
  -- Part of the price of the stay (re-priced by alterations); extras and manual adjustments are not.
  stay_component boolean not null default false,
  source text not null default 'pms' check (source in ('pms', 'channel', 'quote')),
  reason text check (reason is null or length(reason) <= 1000),
  nightly jsonb,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id),
  constraint reservation_lines_reason check (kind not in ('adjustment', 'cancellation') or reason is not null)
);

create index reservation_lines_reservation_idx on public.reservation_lines (reservation_id, id);

create table public.reservation_payments (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  reservation_id uuid not null,
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000),
  method text not null check (method in ('cash', 'bank_transfer', 'card_external', 'check', 'channel_collected', 'other')),
  received_at timestamptz not null default now(),
  reference text check (reference is null or length(reference) <= 200),
  note text check (note is null or length(note) <= 1000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id)
);

create index reservation_payments_reservation_idx on public.reservation_payments (reservation_id, id);

create or replace function private.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger reservation_lines_append_only before update or delete on public.reservation_lines
  for each row execute function private.append_only();
create trigger reservation_payments_append_only before update or delete on public.reservation_payments
  for each row execute function private.append_only();

-- 30 days after check-out the financial lines are locked: only adjustments (with a reason).
create or replace function private.reservation_line_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.reservations;
  v_tz text;
begin
  select * into v_r from public.reservations where id = new.reservation_id;
  select l.timezone into v_tz from public.listings l where l.id = v_r.listing_id;
  if new.kind not in ('adjustment', 'cancellation')
     and v_r.check_out + 30 < (now() at time zone coalesce(v_tz, 'America/New_York'))::date then
    raise exception 'financials_locked: 30 days after check-out only adjustments with a reason can be added' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger reservation_lines_rules before insert on public.reservation_lines
  for each row execute function private.reservation_line_rules();

create trigger audit_reservation_lines after insert on public.reservation_lines
  for each row execute function private.audit_row_change();
create trigger audit_reservation_payments after insert on public.reservation_payments
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Activity (RES-18), notes and files (RES-17)
-- ---------------------------------------------------------------------------

create table public.reservation_activity (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  reservation_id uuid not null,
  kind text not null,
  summary text not null,
  data jsonb not null default '{}'::jsonb,
  actor_type text not null,
  actor_id text,
  actor_user_id uuid,
  occurred_at timestamptz not null default now(),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id)
);

create index reservation_activity_reservation_idx on public.reservation_activity (reservation_id, id desc);

create trigger reservation_activity_append_only before update or delete on public.reservation_activity
  for each row execute function private.append_only();

create or replace function private.log_reservation_activity(p_reservation_id uuid, p_kind text, p_summary text, p_data jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.reservation_activity (account_id, reservation_id, kind, summary, data, actor_type, actor_id, actor_user_id)
  select r.account_id, r.id, p_kind, p_summary, coalesce(p_data, '{}'::jsonb), a.actor_type, a.actor_id, a.user_id
  from public.reservations r cross join private.current_actor() a
  where r.id = p_reservation_id
$$;

create table public.reservation_notes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  reservation_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 10000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id)
);

create table public.reservation_files (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  reservation_id uuid not null,
  -- "<account_id>/<reservation_id>/<file>" in the private bucket `reservation-files`
  storage_path text not null unique check (length(storage_path) <= 500 and storage_path !~ '\.\.'),
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  content_type text not null check (length(content_type) <= 100),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id),
  constraint reservation_files_path check (starts_with(storage_path, account_id::text || '/' || reservation_id::text || '/'))
);

create trigger reservation_notes_append_only before update or delete on public.reservation_notes
  for each row execute function private.append_only();
create trigger reservation_files_no_update before update on public.reservation_files
  for each row execute function private.append_only();
create trigger audit_reservation_notes after insert on public.reservation_notes
  for each row execute function private.audit_row_change();
create trigger audit_reservation_files after insert or delete on public.reservation_files
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Settings (RES-04) and saved views (RES-13)
-- ---------------------------------------------------------------------------

create table public.reservation_source_settings (
  account_id uuid not null references public.accounts (id),
  source text not null check (source in ('direct', 'phone', 'email', 'walk_in', 'website', 'booking_com', 'airbnb', 'vrbo', 'other')),
  approval_hours integer not null default 24 check (approval_hours between 1 and 168),
  updated_at timestamptz not null default now(),
  primary key (account_id, source)
);

create trigger reservation_source_settings_touch before update on public.reservation_source_settings
  for each row execute function private.touch_updated_at();
create trigger audit_reservation_source_settings after insert or update or delete on public.reservation_source_settings
  for each row execute function private.audit_row_change();

create table public.reservation_saved_views (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger reservation_saved_views_touch before update on public.reservation_saved_views
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.new_reservation_code(p_account_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_code text;
begin
  loop
    v_bytes := extensions.gen_random_bytes(7);
    v_code := 'R' || (select string_agg(substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1), '' order by i)
                      from generate_series(0, 6) i);
    exit when not exists (select 1 from public.reservations r where r.account_id = p_account_id and r.code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Loads a reservation and checks the caller holds the permission on it (system callers may).
create or replace function private.reservation_authorize(p_reservation_id uuid, p_permission text)
returns public.reservations
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_l public.listings;
begin
  select * into v from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'reservation_not_found: %', p_reservation_id using errcode = 'P0002';
  end if;
  if private.calendar_is_system() then
    return v;
  end if;
  select * into v_l from public.listings where id = v.listing_id;
  if auth.uid() is null
     or not private.has_permission(v.account_id, 'reservations.view')
     or not private.can_access_listing(v_l.account_id, v_l.id, private.listing_scope_tags(v_l)) then
    raise exception 'reservation_not_found: %', p_reservation_id using errcode = 'P0002';
  end if;
  if not private.has_permission(v.account_id, p_permission) then
    raise exception 'forbidden: % on reservation %', p_permission, v.code using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function private.assert_not_channel(p_r public.reservations, p_what text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.is_channel_source(p_r.source) and not (current_setting('pms.channel_sync', true) = 'on') then
    raise exception 'change_on_channel: % of a % reservation must be done on the channel', p_what, p_r.source using errcode = 'P0001';
  end if;
end;
$$;

-- Guest-facing total and the part re-priced by alterations.
-- Security invoker: callers see only the lines and payments RLS lets them see (view_money);
-- the security-definer RPCs of this module run it as the owner.
create or replace function private.reservation_totals(p_reservation_id uuid, out guest_total bigint, out stay_total bigint, out commission bigint, out paid bigint)
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(l.amount_cents) from public.reservation_lines l where l.reservation_id = p_reservation_id and l.kind <> 'commission'), 0)::bigint,
         coalesce((select sum(l.amount_cents) from public.reservation_lines l where l.reservation_id = p_reservation_id and l.stay_component), 0)::bigint,
         coalesce((select sum(l.amount_cents) from public.reservation_lines l where l.reservation_id = p_reservation_id and l.kind = 'commission'), 0)::bigint,
         coalesce((select sum(p.amount_cents) from public.reservation_payments p where p.reservation_id = p_reservation_id), 0)::bigint
$$;

-- Snapshot a quote_stay() result as lines.
create or replace function private.insert_quote_lines(p_r public.reservations, p_quote jsonb, p_source text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.reservation_lines (account_id, reservation_id, kind, label, quantity, unit_amount_cents, amount_cents,
                                        stay_component, source, nightly)
  select p_r.account_id, p_r.id,
         case x ->> 'code' when 'weekly_discount' then 'discount' when 'monthly_discount' then 'discount' else x ->> 'code' end,
         x ->> 'label', coalesce((x ->> 'quantity')::integer, 1), (x ->> 'unit_amount_cents')::bigint, (x ->> 'amount_cents')::bigint,
         true, p_source,
         case when x ->> 'code' = 'accommodation' then p_quote -> 'nightly' end
  from jsonb_array_elements(p_quote -> 'lines') x
$$;

create or replace function private.approval_deadline(p_account_id uuid, p_source text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select now() + make_interval(hours => coalesce(
    (select s.approval_hours from public.reservation_source_settings s where s.account_id = p_account_id and s.source = p_source), 24))
$$;

-- ---------------------------------------------------------------------------
-- Core: create (RES-01, RES-02, RES-16)
-- ---------------------------------------------------------------------------

create or replace function private.create_reservation_core(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_guest_id uuid,
  p_status public.reservation_status,
  p_kind text,
  p_source text,
  p_adults integer,
  p_children integer,
  p_infants integer,
  p_pets integer,
  p_channel_reservation_id text,
  p_lines jsonb,              -- channel lines (array of {kind,label,amount_cents,...}); null = price with quote_stay
  p_commission_cents bigint,
  p_price_override_cents bigint,
  p_override_reason text,
  p_deadline timestamptz,
  p_eta time,
  p_etd time,
  p_tags text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings;
  v_rules public.listings;
  v_r public.reservations;
  v_hold uuid;
  v_unit uuid;
  v_quote jsonb;
  v_totals record;
  v_id uuid;
begin
  select * into v_l from public.listings where id = p_listing_id;
  if not found then
    raise exception 'listing_not_found: %', p_listing_id using errcode = 'P0002';
  end if;
  v_rules := private.rules_listing(v_l);
  if p_kind = 'owner_stay' and p_status <> 'confirmed' then
    raise exception 'owner_stay_confirmed: owner stays are created confirmed' using errcode = '22023';
  end if;
  if p_status = 'reserved' and p_deadline is null then
    p_deadline := private.approval_deadline(v_l.account_id, p_source);
  end if;

  -- The hold comes first (source = the new reservation id), so the row is written complete.
  v_id := gen_random_uuid();
  if p_status in ('reserved', 'confirmed') then
    v_hold := private.place_hold_internal(v_l.id, p_check_in, p_check_out,
      case when p_kind = 'owner_stay' then 'owner_stay' else 'reservation' end, v_id,
      case when p_status = 'reserved' then p_deadline end, null, null, false,
      greatest(coalesce(p_adults, 1) + coalesce(p_children, 0), 1));
    select h.listing_id into v_unit from public.calendar_holds h where h.id = v_hold;
  end if;

  insert into public.reservations (id, account_id, code, kind, status, listing_id, unit_id, hold_id, guest_id, source,
                                   channel_reservation_id, check_in, check_out, adults, children, infants, pets, currency,
                                   cancellation_policy, approval_deadline, eta, etd, tags)
  values (v_id, v_l.account_id, private.new_reservation_code(v_l.account_id), coalesce(p_kind, 'guest'), p_status, v_l.id,
          v_unit, v_hold, p_guest_id, coalesce(p_source, 'direct'), p_channel_reservation_id, p_check_in, p_check_out,
          coalesce(p_adults, 1), coalesce(p_children, 0), coalesce(p_infants, 0), coalesce(p_pets, 0),
          v_rules.currency, v_rules.cancellation_policy,
          case when p_status = 'reserved' then p_deadline end, p_eta, p_etd, coalesce(p_tags, '{}'))
  returning * into v_r;

  if coalesce(p_kind, 'guest') <> 'owner_stay' then
    if p_lines is not null then
      insert into public.reservation_lines (account_id, reservation_id, kind, label, quantity, unit_amount_cents, amount_cents,
                                            stay_component, source, reason)
      select v_r.account_id, v_r.id, x ->> 'kind', x ->> 'label', coalesce((x ->> 'quantity')::integer, 1),
             (x ->> 'unit_amount_cents')::bigint, (x ->> 'amount_cents')::bigint,
             (x ->> 'kind') in ('accommodation', 'extra_guest_fee', 'cleaning_fee', 'pet_fee', 'discount'),
             coalesce(nullif(current_setting('pms.line_source', true), ''), 'channel'), x ->> 'reason'
      from jsonb_array_elements(p_lines) x;
    else
      v_quote := public.quote_stay(v_l.id, p_check_in, p_check_out,
                                   greatest(coalesce(p_adults, 1) + coalesce(p_children, 0), 1), coalesce(p_pets, 0));
      perform private.insert_quote_lines(v_r, v_quote, 'pms');
      if p_price_override_cents is not null then
        if nullif(btrim(p_override_reason), '') is null then
          raise exception 'override_reason_required: a price override needs a reason' using errcode = '22023';
        end if;
        if p_price_override_cents < 0 then
          raise exception 'invalid_price: the total cannot be negative' using errcode = '22023';
        end if;
        select * into v_totals from private.reservation_totals(v_r.id);
        if p_price_override_cents <> v_totals.guest_total then
          insert into public.reservation_lines (account_id, reservation_id, kind, label, amount_cents, stay_component, reason)
          values (v_r.account_id, v_r.id, 'adjustment', 'Price override', p_price_override_cents - v_totals.guest_total, true, btrim(p_override_reason));
        end if;
      end if;
    end if;
    if coalesce(p_commission_cents, 0) <> 0 then
      insert into public.reservation_lines (account_id, reservation_id, kind, label, amount_cents, source)
      values (v_r.account_id, v_r.id, 'commission', 'Channel commission', p_commission_cents,
              case when p_lines is not null then 'channel' else 'pms' end);
    end if;
  end if;

  perform private.log_reservation_activity(v_r.id, 'created',
    format('Created as %s (%s, %s to %s)', p_status, coalesce(p_source, 'direct'), p_check_in, p_check_out),
    jsonb_build_object('status', p_status, 'source', p_source, 'hold_id', v_hold, 'unit_id', v_unit));
  return v_r.id;
end;
$$;

-- Creates a guest from a JSON object (first_name required) or returns p_guest_id after checking it.
create or replace function private.resolve_guest(p_account_id uuid, p_guest_id uuid, p_guest jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_guest_id is not null then
    select g.id into v_id from public.guests g where g.id = p_guest_id and g.account_id = p_account_id;
    if v_id is null then
      raise exception 'guest_not_found' using errcode = 'P0002';
    end if;
    -- Follow merges.
    while exists (select 1 from public.guests g where g.id = v_id and g.merged_into_id is not null) loop
      select g.merged_into_id into v_id from public.guests g where g.id = v_id;
    end loop;
    return v_id;
  end if;
  if p_guest is null or nullif(btrim(p_guest ->> 'first_name'), '') is null then
    return null;
  end if;
  insert into public.guests (account_id, first_name, last_name, email, phone, language, nationality)
  values (p_account_id, p_guest ->> 'first_name', p_guest ->> 'last_name', p_guest ->> 'email', p_guest ->> 'phone',
          nullif(p_guest ->> 'language', ''), nullif(upper(p_guest ->> 'nationality'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- RES-01 / RES-16: manual reservation, inquiry or owner stay.
create or replace function public.create_reservation(
  p_listing_id uuid,
  p_check_in date,
  p_check_out date,
  p_status public.reservation_status default 'confirmed',
  p_guest_id uuid default null,
  p_guest jsonb default null,
  p_adults integer default 1,
  p_children integer default 0,
  p_infants integer default 0,
  p_pets integer default 0,
  p_source text default 'direct',
  p_kind text default 'guest',
  p_price_override_cents bigint default null,
  p_override_reason text default null,
  p_eta time default null,
  p_etd time default null,
  p_tags text[] default '{}',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings := private.calendar_authorize(p_listing_id, 'reservations.create');
  v_guest uuid;
  v_id uuid;
begin
  if private.is_channel_source(p_source) then
    raise exception 'channel_source: % bookings come from the channel' , p_source using errcode = '22023';
  end if;
  if p_kind = 'owner_stay' then
    p_status := 'confirmed';
    p_source := 'owner';
  elsif p_source = 'owner' then
    raise exception 'invalid_source: owner is for owner stays' using errcode = '22023';
  end if;
  if p_status not in ('inquiry', 'reserved', 'confirmed') then
    raise exception 'reservation_status_invalid: create as inquiry, reserved or confirmed' using errcode = '22023';
  end if;
  v_guest := private.resolve_guest(v_l.account_id, p_guest_id, p_guest);
  if v_guest is null and p_kind <> 'owner_stay' then
    raise exception 'guest_required: choose or create a guest' using errcode = '22023';
  end if;
  v_id := private.create_reservation_core(p_listing_id, p_check_in, p_check_out, v_guest, p_status, p_kind, p_source,
    p_adults, p_children, p_infants, p_pets, null, null, null, p_price_override_cents, p_override_reason, null,
    p_eta, p_etd, p_tags);
  if nullif(btrim(p_note), '') is not null then
    insert into public.reservation_notes (account_id, reservation_id, body) values (v_l.account_id, v_id, btrim(p_note));
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status changes (RES-03, RES-04, RES-07)
-- ---------------------------------------------------------------------------

create or replace function private.release_reservation_hold(p_r public.reservations, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_r.hold_id is not null then
    perform public.release_hold(p_r.hold_id, p_reason);
  end if;
end;
$$;

-- inquiry → reserved / confirmed (places the hold), reserved → confirmed (approve).
create or replace function public.confirm_reservation(p_reservation_id uuid, p_to public.reservation_status default 'confirmed')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_hold uuid;
  v_unit uuid;
  v_deadline timestamptz;
begin
  select * into v from public.reservations where id = p_reservation_id for update;
  v := private.reservation_authorize(p_reservation_id, case when v.status = 'inquiry' then 'reservations.create' else 'reservations.edit' end);
  if v.status = 'reserved' and p_to = 'confirmed' then
    if v.approval_deadline is not null and v.approval_deadline <= now() then
      raise exception 'approval_deadline_passed: the request expired at %', v.approval_deadline using errcode = 'P0001';
    end if;
    perform public.set_hold_expiry(v.hold_id, null);
    update public.reservations set status = 'confirmed', approval_deadline = null where id = v.id;
    perform private.log_reservation_activity(v.id, 'status', 'Approved (reserved → confirmed)', jsonb_build_object('from', v.status, 'to', 'confirmed'));
    return;
  end if;
  if v.status <> 'inquiry' or p_to not in ('reserved', 'confirmed') then
    raise exception 'reservation_transition_invalid: % to % is not allowed', v.status, p_to using errcode = '55000';
  end if;
  if p_to = 'reserved' then
    v_deadline := private.approval_deadline(v.account_id, v.source);
  end if;
  v_hold := private.place_hold_internal(v.listing_id, v.check_in, v.check_out, 'reservation', v.id, v_deadline, null, null, false,
                                         greatest(v.adults + v.children, 1));
  select h.listing_id into v_unit from public.calendar_holds h where h.id = v_hold;
  update public.reservations set status = p_to, hold_id = v_hold, unit_id = v_unit, approval_deadline = v_deadline where id = v.id;
  perform private.log_reservation_activity(v.id, 'status', format('Inquiry → %s', p_to), jsonb_build_object('from', v.status, 'to', p_to));
end;
$$;

-- reserved → declined, inquiry → closed.
create or replace function public.decline_reservation(p_reservation_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_to public.reservation_status;
begin
  select * into v from public.reservations where id = p_reservation_id for update;
  v := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  v_to := case v.status when 'reserved' then 'declined' when 'inquiry' then 'closed' end;
  if v_to is null then
    raise exception 'reservation_transition_invalid: a % reservation cannot be declined or closed', v.status using errcode = '55000';
  end if;
  perform private.assert_not_channel(v, 'Declining');
  perform private.release_reservation_hold(v, coalesce(p_reason, v_to::text));
  update public.reservations set status = v_to, status_reason = nullif(btrim(p_reason), ''), approval_deadline = null where id = v.id;
  perform private.log_reservation_activity(v.id, 'status', format('%s → %s', v.status, v_to), jsonb_build_object('from', v.status, 'to', v_to, 'reason', p_reason));
end;
$$;

-- RES-07 refund rules (mirrored in src/lib/reservations/refunds.ts; parity is tested).
create or replace function private.refund_percent(p_policy text, p_canceled_by text, p_days_before integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_canceled_by in ('host', 'channel') then 100
    when p_policy = 'flexible' then case when p_days_before >= 1 then 100 else 0 end
    when p_policy = 'moderate' then case when p_days_before >= 5 then 100 else 50 end
    when p_policy = 'strict' then case when p_days_before >= 7 then 50 else 0 end
    else 0
  end
$$;

-- RES-07: cancel a confirmed reservation. Returns the refund calculation; with p_preview nothing changes.
create or replace function public.cancel_reservation(
  p_reservation_id uuid,
  p_canceled_by text default 'host',
  p_reason text default null,
  p_refund_percent integer default null,
  p_preview boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_tz text;
  v_days integer;
  v_pct integer;
  v_t record;
  v_kept bigint;
begin
  select * into v from public.reservations where id = p_reservation_id for update;
  v := private.reservation_authorize(p_reservation_id, 'reservations.cancel');
  if v.status <> 'confirmed' then
    raise exception 'reservation_transition_invalid: only confirmed reservations are canceled (this one is %)', v.status using errcode = '55000';
  end if;
  if p_canceled_by not in ('host', 'guest', 'channel') or (p_canceled_by = 'channel' and current_setting('pms.channel_sync', true) is distinct from 'on') then
    raise exception 'invalid_canceled_by: host or guest' using errcode = '22023';
  end if;
  perform private.assert_not_channel(v, 'Canceling');
  if v.stay_status in ('checked_in', 'checked_out') then
    raise exception 'reservation_in_progress: a stay that started cannot be canceled' using errcode = 'P0001';
  end if;
  select l.timezone into v_tz from public.listings l where l.id = v.listing_id;
  v_days := v.check_in - (now() at time zone v_tz)::date;
  v_pct := private.refund_percent(v.cancellation_policy, p_canceled_by, v_days);
  if p_refund_percent is not null then
    if not private.calendar_is_system() and not private.has_permission(v.account_id, 'reservations.manage') then
      raise exception 'forbidden: a custom refund needs reservations.manage' using errcode = '42501';
    end if;
    if p_refund_percent not between 0 and 100 then
      raise exception 'invalid_refund_percent' using errcode = '22023';
    end if;
    v_pct := p_refund_percent;
  end if;
  select * into v_t from private.reservation_totals(v.id);
  v_kept := v_t.guest_total - (v_t.guest_total * v_pct + 50) / 100;  -- half-up
  if v.kind = 'owner_stay' then
    v_kept := 0;
  end if;

  if not p_preview then
    perform private.release_reservation_hold(v, 'canceled');
    if v_kept <> v_t.guest_total then
      insert into public.reservation_lines (account_id, reservation_id, kind, label, amount_cents, reason)
      values (v.account_id, v.id, 'cancellation', format('Cancellation (%s%% refundable)', v_pct), v_kept - v_t.guest_total,
              coalesce(nullif(btrim(p_reason), ''), 'Canceled by ' || p_canceled_by));
    end if;
    update public.reservations
    set status = 'canceled', canceled_by = p_canceled_by, status_reason = nullif(btrim(p_reason), ''), refund_percent = v_pct
    where id = v.id;
    perform private.log_reservation_activity(v.id, 'status', format('Canceled by %s (%s%% refundable)', p_canceled_by, v_pct),
      jsonb_build_object('from', 'confirmed', 'to', 'canceled', 'refund_percent', v_pct, 'kept_cents', v_kept, 'reason', p_reason));
  end if;

  return jsonb_build_object('policy', v.cancellation_policy, 'days_before_check_in', v_days, 'refund_percent', v_pct,
    'guest_total_cents', v_t.guest_total, 'kept_cents', v_kept, 'paid_cents', v_t.paid,
    'refund_due_cents', greatest(v_t.paid - v_kept, 0), 'balance_due_cents', greatest(v_kept - v_t.paid, 0));
end;
$$;

-- RES-04: Reserved past its deadline → Expired; inquiries whose check-in passed → Closed.
-- Callable by the service role (all accounts) and by members (their accounts only).
create or replace function public.expire_overdue_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_count integer := 0;
  v_system boolean := private.calendar_is_system();
begin
  for v in
    select r.* from public.reservations r
    join public.listings l on l.id = r.listing_id
    where ((r.status = 'reserved' and r.approval_deadline <= now())
           or (r.status = 'inquiry' and r.check_in < (now() at time zone l.timezone)::date))
      and (v_system or private.is_member(r.account_id))
    order by r.id
    for update of r skip locked
  loop
    if v.status = 'reserved' then
      -- The calendar hold expired at the deadline already (it no longer blocks); the calendar's
      -- own sweep marks it expired. Releasing it here would need calendar rights the caller may lack.
      update public.reservations set status = 'expired', status_reason = 'Approval deadline passed' where id = v.id;
      perform private.log_reservation_activity(v.id, 'status', 'Expired (approval deadline passed)', jsonb_build_object('from', 'reserved', 'to', 'expired'));
    else
      update public.reservations set status = 'closed', status_reason = 'Check-in date passed' where id = v.id;
      perform private.log_reservation_activity(v.id, 'status', 'Closed (check-in date passed)', jsonb_build_object('from', 'inquiry', 'to', 'closed'));
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- RES-11 stay status, ETA / ETD; tags.
create or replace function public.set_stay_status(p_reservation_id uuid, p_stay_status public.stay_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.edit');
begin
  update public.reservations set stay_status = p_stay_status where id = v.id;
  perform private.log_reservation_activity(v.id, 'stay', format('Stay status: %s → %s', v.stay_status, p_stay_status),
    jsonb_build_object('from', v.stay_status, 'to', p_stay_status));
end;
$$;

create or replace function public.update_reservation_details(
  p_reservation_id uuid,
  p_eta time default null,
  p_etd time default null,
  p_tags text[] default null,
  p_clear_times boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.edit');
begin
  update public.reservations
  set eta = case when p_clear_times then p_eta else coalesce(p_eta, eta) end,
      etd = case when p_clear_times then p_etd else coalesce(p_etd, etd) end,
      tags = coalesce(p_tags, tags)
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alterations (RES-06)
-- ---------------------------------------------------------------------------

-- Change dates, guest counts and/or listing of an inquiry, reserved or confirmed reservation.
-- Returns before/after; with p_preview nothing changes. The calendar move is atomic: on a
-- conflict nothing is changed. p_keep_price keeps the current total; p_new_total_cents sets it
-- (with p_reason).
create or replace function public.alter_reservation(
  p_reservation_id uuid,
  p_check_in date default null,
  p_check_out date default null,
  p_listing_id uuid default null,
  p_adults integer default null,
  p_children integer default null,
  p_infants integer default null,
  p_pets integer default null,
  p_preview boolean default false,
  p_keep_price boolean default false,
  p_new_total_cents bigint default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_ci date;
  v_co date;
  v_listing uuid;
  v_target public.listings;
  v_adults integer;
  v_children integer;
  v_infants integer;
  v_pets integer;
  v_t record;
  v_quote jsonb;
  v_new_stay bigint;
  v_diff bigint;
  v_avail record;
  v_unit uuid;
  v_changes jsonb;
begin
  select * into v from public.reservations where id = p_reservation_id for update;
  v := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  if v.status not in ('inquiry', 'reserved', 'confirmed') then
    raise exception 'reservation_final: a % reservation cannot be altered', v.status using errcode = '55000';
  end if;
  if v.stay_status in ('checked_out', 'no_show') then
    raise exception 'reservation_final: the stay is over' using errcode = '55000';
  end if;
  perform private.assert_not_channel(v, 'Altering');

  v_ci := coalesce(p_check_in, v.check_in);
  v_co := coalesce(p_check_out, v.check_out);
  v_listing := coalesce(p_listing_id, v.listing_id);
  v_adults := coalesce(p_adults, v.adults);
  v_children := coalesce(p_children, v.children);
  v_infants := coalesce(p_infants, v.infants);
  v_pets := coalesce(p_pets, v.pets);
  if v.stay_status = 'checked_in' and v_ci <> v.check_in then
    raise exception 'reservation_in_progress: the guest is checked in; only check-out can change' using errcode = 'P0001';
  end if;
  v_target := private.calendar_authorize(v_listing, 'reservations.edit');
  if v_target.account_id <> v.account_id then
    raise exception 'listing_not_found: %', v_listing using errcode = 'P0002';
  end if;

  v_changes := private.row_diff(
    jsonb_build_object('check_in', v.check_in, 'check_out', v.check_out, 'listing_id', v.listing_id, 'adults', v.adults,
                       'children', v.children, 'infants', v.infants, 'pets', v.pets),
    jsonb_build_object('check_in', v_ci, 'check_out', v_co, 'listing_id', v_listing, 'adults', v_adults,
                       'children', v_children, 'infants', v_infants, 'pets', v_pets), '{}');

  select * into v_t from private.reservation_totals(v.id);
  if v.kind = 'owner_stay' then
    v_new_stay := 0;
  else
    v_quote := public.quote_stay(v_listing, v_ci, v_co, greatest(v_adults + v_children, 1), v_pets);
    v_new_stay := (v_quote ->> 'total_cents')::bigint;
  end if;
  v_diff := case
    when p_new_total_cents is not null then p_new_total_cents - v_t.guest_total
    when p_keep_price or v.kind = 'owner_stay' then 0
    else v_new_stay - v_t.stay_total
  end;

  if p_preview then
    select * into v_avail from public.check_availability(v_listing, v_ci, v_co, greatest(v_adults + v_children, 1), v.hold_id);
    return jsonb_build_object(
      'changes', v_changes,
      'before', jsonb_build_object('check_in', v.check_in, 'check_out', v.check_out, 'listing_id', v.listing_id, 'nights', v.check_out - v.check_in,
                                   'total_cents', v_t.guest_total),
      'after', jsonb_build_object('check_in', v_ci, 'check_out', v_co, 'listing_id', v_listing, 'nights', v_co - v_ci,
                                  'total_cents', v_t.guest_total + v_diff, 'quote', v_quote),
      'difference_cents', v_diff,
      'available', case when v.status = 'inquiry' then true else v_avail.bookable end,
      'availability', jsonb_build_object('failures', v_avail.failures, 'message', v_avail.message));
  end if;

  if v_changes = '{}'::jsonb then
    return jsonb_build_object('changes', v_changes, 'difference_cents', 0);
  end if;
  if p_new_total_cents is not null and nullif(btrim(p_reason), '') is null then
    raise exception 'override_reason_required: a price override needs a reason' using errcode = '22023';
  end if;

  if v.hold_id is not null then
    v_unit := public.move_hold(v.hold_id, v_ci, v_co, case when v_listing <> v.listing_id then v_listing end);
  end if;
  update public.reservations
  set check_in = v_ci, check_out = v_co, listing_id = v_listing, unit_id = coalesce(v_unit, unit_id),
      adults = v_adults, children = v_children, infants = v_infants, pets = v_pets
  where id = v.id;
  if v_diff <> 0 then
    insert into public.reservation_lines (account_id, reservation_id, kind, label, amount_cents, stay_component, reason)
    values (v.account_id, v.id, 'adjustment', 'Alteration', v_diff, p_new_total_cents is null,
            coalesce(nullif(btrim(p_reason), ''), format('Alteration: %s', (select string_agg(k, ', ') from jsonb_object_keys(v_changes) k))));
  end if;
  perform private.log_reservation_activity(v.id, 'alteration', 'Altered: ' || (select string_agg(k, ', ') from jsonb_object_keys(v_changes) k),
    jsonb_build_object('changes', v_changes, 'difference_cents', v_diff));
  return jsonb_build_object('changes', v_changes, 'difference_cents', v_diff, 'unit_id', v_unit);
end;
$$;

-- CAL-11 drag on the grid: move a booking to another unit of the same multi-unit (same dates).
create or replace function public.reassign_reservation_unit(p_reservation_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_unit public.listings;
begin
  select * into v from public.reservations where id = p_reservation_id for update;
  v := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  perform private.assert_not_channel(v, 'Moving');
  select * into v_unit from public.listings where id = p_unit_id;
  if v.hold_id is null or not found or v_unit.type <> 'sub_unit'
     or v_unit.parent_id is distinct from (select coalesce(l.parent_id, l.id) from public.listings l where l.id = v.unit_id) then
    raise exception 'invalid_unit: pick a unit of the same multi-unit' using errcode = '22023';
  end if;
  perform public.move_hold(v.hold_id, v.check_in, v.check_out, p_unit_id);
  update public.reservations set unit_id = p_unit_id where id = v.id;
  perform private.log_reservation_activity(v.id, 'alteration', 'Moved to another unit',
    jsonb_build_object('from_unit', v.unit_id, 'to_unit', p_unit_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Money actions, notes, files (RES-09, RES-10, RES-17)
-- ---------------------------------------------------------------------------

create or replace function public.add_reservation_line(
  p_reservation_id uuid,
  p_kind text,
  p_label text,
  p_amount_cents bigint,
  p_reason text default null,
  p_quantity integer default 1
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_id bigint;
begin
  if p_kind not in ('extra', 'adjustment') then
    raise exception 'invalid_line_kind: extra or adjustment' using errcode = '22023';
  end if;
  v := private.reservation_authorize(p_reservation_id, case when p_kind = 'extra' then 'reservations.edit' else 'reservations.manage' end);
  if not private.calendar_is_system() and not private.has_permission(v.account_id, 'reservations.view_money') then
    raise exception 'forbidden: reservations.view_money' using errcode = '42501';
  end if;
  if v.kind = 'owner_stay' then
    raise exception 'owner_stay_no_money: owner stays have no price' using errcode = '22023';
  end if;
  if p_kind = 'extra' and v.status in ('declined', 'expired', 'closed', 'canceled') then
    raise exception 'reservation_final: extras cannot be added to a % reservation', v.status using errcode = '55000';
  end if;
  if p_kind = 'extra' and (p_amount_cents < 0 or coalesce(p_quantity, 1) < 1) then
    raise exception 'invalid_extra: extras are positive; use an adjustment for credits' using errcode = '22023';
  end if;
  insert into public.reservation_lines (account_id, reservation_id, kind, label, quantity, unit_amount_cents, amount_cents, reason)
  values (v.account_id, v.id, p_kind, btrim(p_label), coalesce(p_quantity, 1),
          case when coalesce(p_quantity, 1) > 1 then p_amount_cents end,
          p_amount_cents * coalesce(p_quantity, 1), nullif(btrim(p_reason), ''))
  returning id into v_id;
  perform private.log_reservation_activity(v.id, 'money', format('%s: %s', initcap(p_kind), btrim(p_label)),
    jsonb_build_object('line_id', v_id, 'amount_cents', p_amount_cents * coalesce(p_quantity, 1), 'reason', p_reason));
  return v_id;
end;
$$;

create or replace function public.record_payment(
  p_reservation_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_received_at timestamptz default null,
  p_reference text default null,
  p_note text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  v_id bigint;
begin
  if not private.calendar_is_system() and not private.has_permission(v.account_id, 'reservations.view_money') then
    raise exception 'forbidden: reservations.view_money' using errcode = '42501';
  end if;
  if v.kind = 'owner_stay' then
    raise exception 'owner_stay_no_money: owner stays have no price' using errcode = '22023';
  end if;
  insert into public.reservation_payments (account_id, reservation_id, amount_cents, method, received_at, reference, note)
  values (v.account_id, v.id, p_amount_cents, p_method, coalesce(p_received_at, now()), nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''))
  returning id into v_id;
  perform private.log_reservation_activity(v.id, 'money',
    format('%s recorded (%s)', case when p_amount_cents < 0 then 'Refund' else 'Payment' end, replace(p_method, '_', ' ')),
    jsonb_build_object('payment_id', v_id, 'amount_cents', p_amount_cents, 'method', p_method));
  return v_id;
end;
$$;

create or replace function public.add_reservation_note(p_reservation_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  v_id uuid;
begin
  insert into public.reservation_notes (account_id, reservation_id, body) values (v.account_id, v.id, btrim(p_body)) returning id into v_id;
  perform private.log_reservation_activity(v.id, 'note', 'Note added', jsonb_build_object('note_id', v_id));
  return v_id;
end;
$$;

create or replace function public.register_reservation_file(p_reservation_id uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.edit');
  v_id uuid;
begin
  insert into public.reservation_files (account_id, reservation_id, storage_path, file_name, content_type, size_bytes)
  values (v.account_id, v.id, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes)
  returning id into v_id;
  perform private.log_reservation_activity(v.id, 'file', format('File attached: %s', btrim(p_file_name)), jsonb_build_object('file_id', v_id));
  return v_id;
end;
$$;

-- Storage path check for the `reservation-files` bucket: "<account>/<reservation>/<file>".
create or replace function private.can_access_reservation_file_path(p_name text, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_name, '/');
  v public.reservations;
  v_l public.listings;
begin
  if cardinality(v_parts) <> 3
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[3] !~ '^[A-Za-z0-9._-]{1,200}$' or v_parts[3] ~ '\.\.' then
    return false;
  end if;
  select * into v from public.reservations r where r.id = v_parts[2]::uuid and r.account_id = v_parts[1]::uuid;
  if not found then
    return false;
  end if;
  select * into v_l from public.listings where id = v.listing_id;
  return private.has_permission(v.account_id, 'reservations.view')
     and private.has_permission(v.account_id, p_permission)
     and private.can_access_listing(v_l.account_id, v_l.id, private.listing_scope_tags(v_l));
end;
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('reservation-files', 'reservation-files', false, 26214400)
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    execute 'drop policy if exists reservation_files_insert on storage.objects';
    execute 'drop policy if exists reservation_files_select on storage.objects';
    execute $p$create policy reservation_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'reservation-files' and private.can_access_reservation_file_path(name, 'reservations.edit'))$p$;
    execute $p$create policy reservation_files_select on storage.objects for select to authenticated
      using (bucket_id = 'reservation-files' and private.can_access_reservation_file_path(name, 'reservations.view'))$p$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guests: merge (RES-12)
-- ---------------------------------------------------------------------------

create or replace function public.merge_guests(p_keep_id uuid, p_merge_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep public.guests;
  v_merge public.guests;
  v_count integer;
begin
  select * into v_keep from public.guests where id = p_keep_id;
  select * into v_merge from public.guests where id = p_merge_id;
  if v_keep.id is null or v_merge.id is null or v_keep.account_id <> v_merge.account_id or v_keep.id = v_merge.id then
    raise exception 'guest_not_found' using errcode = 'P0002';
  end if;
  if not private.calendar_is_system() and not private.has_permission(v_keep.account_id, 'reservations.manage') then
    raise exception 'forbidden: merging guests needs reservations.manage' using errcode = '42501';
  end if;
  if v_keep.merged_into_id is not null or v_merge.merged_into_id is not null then
    raise exception 'guest_already_merged' using errcode = 'P0001';
  end if;
  perform set_config('pms.guest_merge', 'on', true);
  update public.reservations set guest_id = v_keep.id where guest_id = v_merge.id;
  get diagnostics v_count = row_count;
  perform set_config('pms.guest_merge', '', true);
  update public.guests g
  set email = coalesce(g.email, v_merge.email),
      phone = coalesce(g.phone, v_merge.phone),
      language = coalesce(g.language, v_merge.language),
      nationality = coalesce(g.nationality, v_merge.nationality),
      last_name = coalesce(g.last_name, v_merge.last_name),
      notes = nullif(concat_ws(E'\n\n', g.notes, v_merge.notes), ''),
      tags = g.tags || v_merge.tags
  where g.id = v_keep.id;
  update public.guests set merged_into_id = v_keep.id where id = v_merge.id;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Channel ingest (RES-02)
-- ---------------------------------------------------------------------------

-- payload: {action: create|modify|cancel, listing_id, check_in, check_out, status (confirmed|reserved),
--           adults, children, infants, pets, guest {first_name, last_name, email, phone, language},
--           lines [{kind, label, amount_cents, quantity?, unit_amount_cents?}], commission_cents,
--           approval_deadline?, reason?}
-- Idempotent on (account, source, external code). Returns {reservation_id, created, changed}.
create or replace function public.ingest_channel_reservation(p_account_id uuid, p_source text, p_external_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reservations;
  v_action text := coalesce(p_payload ->> 'action', 'create');
  v_id uuid;
  v_guest uuid;
  v_t record;
  v_new_total bigint;
  v_ci date := (p_payload ->> 'check_in')::date;
  v_co date := (p_payload ->> 'check_out')::date;
  v_listing uuid := (p_payload ->> 'listing_id')::uuid;
  v_changed boolean := false;
begin
  if not private.calendar_is_system() then
    raise exception 'forbidden: channel ingest is for the channel integration' using errcode = '42501';
  end if;
  if not private.is_channel_source(p_source) or nullif(btrim(p_external_id), '') is null then
    raise exception 'invalid_channel: source must be a channel and the external code is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|' || p_source || '|' || p_external_id, 0));
  perform set_config('pms.channel_sync', 'on', true);
  perform set_config('pms.actor_type', 'channel', true);
  perform set_config('pms.actor_id', p_source, true);

  select * into v from public.reservations r
  where r.account_id = p_account_id and r.source = p_source and r.channel_reservation_id = p_external_id
  for update;

  if not found then
    if v_action = 'cancel' then
      return jsonb_build_object('reservation_id', null, 'created', false, 'changed', false, 'ignored', 'unknown reservation');
    end if;
    if not exists (select 1 from public.listings l where l.id = v_listing and l.account_id = p_account_id) then
      raise exception 'listing_not_found: %', v_listing using errcode = 'P0002';
    end if;
    v_guest := private.resolve_guest(p_account_id, null, coalesce(p_payload -> 'guest', '{"first_name": "Guest"}'::jsonb));
    v_id := private.create_reservation_core(v_listing, v_ci, v_co, v_guest,
      coalesce(p_payload ->> 'status', 'confirmed')::public.reservation_status, 'guest', p_source,
      (p_payload ->> 'adults')::integer, (p_payload ->> 'children')::integer, (p_payload ->> 'infants')::integer, (p_payload ->> 'pets')::integer,
      p_external_id, coalesce(p_payload -> 'lines', '[]'::jsonb), (p_payload ->> 'commission_cents')::bigint, null, null,
      (p_payload ->> 'approval_deadline')::timestamptz, null, null, '{}');
    return jsonb_build_object('reservation_id', v_id, 'created', true, 'changed', true);
  end if;

  if v_action = 'cancel' then
    if v.status = 'confirmed' then
      perform public.cancel_reservation(v.id, 'channel', coalesce(p_payload ->> 'reason', 'Canceled on ' || p_source));
      v_changed := true;
    elsif v.status = 'reserved' then
      perform private.release_reservation_hold(v, 'canceled on channel');
      update public.reservations set status = 'declined', status_reason = 'Withdrawn on ' || p_source where id = v.id;
      v_changed := true;
    end if;
    return jsonb_build_object('reservation_id', v.id, 'created', false, 'changed', v_changed);
  end if;

  -- create (duplicate delivery) or modify
  if v.status = 'reserved' and p_payload ->> 'status' = 'confirmed' then
    perform public.confirm_reservation(v.id, 'confirmed');
    v_changed := true;
  end if;
  if v.status in ('inquiry', 'reserved', 'confirmed')
     and ((v_ci is not null and v_ci <> v.check_in) or (v_co is not null and v_co <> v.check_out)
          or (v_listing is not null and v_listing <> v.listing_id)
          or coalesce((p_payload ->> 'adults')::integer, v.adults) <> v.adults
          or coalesce((p_payload ->> 'children')::integer, v.children) <> v.children) then
    perform public.alter_reservation(v.id, v_ci, v_co, case when v_listing <> v.listing_id then v_listing end,
      (p_payload ->> 'adults')::integer, (p_payload ->> 'children')::integer, (p_payload ->> 'infants')::integer,
      (p_payload ->> 'pets')::integer, false, true);
    v_changed := true;
  end if;
  if p_payload ? 'lines' then
    v_new_total := (select coalesce(sum((x ->> 'amount_cents')::bigint), 0) from jsonb_array_elements(p_payload -> 'lines') x
                    where x ->> 'kind' <> 'commission');
    select * into v_t from private.reservation_totals(v.id);
    if v_new_total <> v_t.guest_total then
      insert into public.reservation_lines (account_id, reservation_id, kind, label, amount_cents, stay_component, source, reason)
      values (v.account_id, v.id, 'adjustment', 'Channel total changed', v_new_total - v_t.guest_total, true, 'channel',
              format('%s reported a total of %s', p_source, v_new_total));
      v_changed := true;
    end if;
  end if;
  return jsonb_build_object('reservation_id', v.id, 'created', false, 'changed', v_changed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads: balances (RES-09), calendar bookings for the grid, search (RES-14, X-08)
-- ---------------------------------------------------------------------------

create view public.reservation_balances
with (security_invoker = true)
as
select r.id as reservation_id,
       r.account_id,
       t.guest_total as guest_total_cents,
       t.commission as commission_cents,
       t.guest_total - t.commission as host_payout_cents,
       t.paid as paid_cents,
       t.guest_total - t.paid as balance_due_cents
from public.reservations r
cross join lateral private.reservation_totals(r.id) t
where private.has_permission(r.account_id, 'reservations.view_money');

-- Bookings (reservation / owner-stay / quote holds) overlapping [p_from, p_to) on these
-- listings and their sub-units, for the multi-calendar grid. Guest names need reservations.view.
create or replace function public.get_calendar_bookings(p_listing_ids uuid[], p_from date, p_to date)
returns table (
  hold_id uuid,
  listing_id uuid,
  check_in date,
  check_out date,
  source_type text,
  expires_at timestamptz,
  reservation_id uuid,
  code text,
  status public.reservation_status,
  stay_status public.stay_status,
  source text,
  guest_name text,
  guests integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_system boolean := private.calendar_is_system();
begin
  if p_to <= p_from or p_to - p_from > 400 then
    raise exception 'invalid_range: up to 400 days, to after from' using errcode = '22023';
  end if;
  return query
  select h.id, h.listing_id, h.check_in, h.check_out, h.source_type, h.expires_at,
         r.id, r.code, r.status, r.stay_status, r.source,
         case when v_system or private.has_permission(h.account_id, 'reservations.view')
              then case when r.kind = 'owner_stay' then 'Owner stay' else btrim(concat_ws(' ', g.first_name, g.last_name)) end end,
         r.adults + r.children
  from public.calendar_holds h
  join public.listings l on l.id = h.listing_id
  left join public.reservations r on r.id = h.source_id and h.source_type in ('reservation', 'owner_stay')
  left join public.guests g on g.id = r.guest_id
  where h.status = 'active'
    and (h.expires_at is null or h.expires_at > now())
    and h.source_type in ('reservation', 'owner_stay', 'quote')
    and h.nights && daterange(p_from, p_to)
    and (h.listing_id = any (p_listing_ids) or l.parent_id = any (p_listing_ids))
    and (v_system or (auth.uid() is not null and private.can_view_listing_calendar(l.account_id, l.id)))
  order by h.listing_id, h.check_in;
end;
$$;

-- RES-14: by confirmation code, channel code, guest name, email or phone.
create or replace function public.search_reservations(p_account_id uuid, p_query text, p_limit integer default 20)
returns setof public.reservations
language sql
stable
set search_path = ''
as $$
  select r.* from public.reservations r
  left join public.guests g on g.id = r.guest_id
  where r.account_id = p_account_id
    and length(btrim(p_query)) >= 2
    and (r.code ilike btrim(p_query) || '%'
         or r.channel_reservation_id ilike btrim(p_query) || '%'
         or concat_ws(' ', g.first_name, g.last_name) ilike '%' || btrim(p_query) || '%'
         or g.email ilike '%' || btrim(p_query) || '%'
         or regexp_replace(coalesce(g.phone, ''), '\D', '', 'g') like '%' || nullif(regexp_replace(p_query, '\D', '', 'g'), '') || '%')
  order by r.check_in desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

-- X-08 global search across listings, reservations and guests (tasks join in step 8).
-- Security invoker: RLS decides what each caller sees.
create or replace function public.global_search(p_account_id uuid, p_query text)
returns table (kind text, id uuid, title text, subtitle text)
language sql
stable
set search_path = ''
as $$
  (select 'listing', l.id, l.internal_name, concat_ws(' · ', l.public_title, l.city)
   from public.listings l
   where l.account_id = p_account_id and length(btrim(p_query)) >= 2
     and (l.internal_name ilike '%' || btrim(p_query) || '%' or l.public_title ilike '%' || btrim(p_query) || '%'
          or l.city ilike '%' || btrim(p_query) || '%' or btrim(p_query) ilike any (l.tags))
   order by l.internal_name limit 10)
  union all
  (select 'reservation', r.id, r.code || ' · ' || coalesce(btrim(concat_ws(' ', g.first_name, g.last_name)), 'Owner stay'),
          concat_ws(' · ', l.internal_name, r.check_in::text || ' → ' || r.check_out::text, r.status::text)
   from public.search_reservations(p_account_id, p_query, 10) r
   left join public.guests g on g.id = r.guest_id
   left join public.listings l on l.id = r.listing_id)
  union all
  (select 'guest', g.id, btrim(concat_ws(' ', g.first_name, g.last_name)), concat_ws(' · ', g.email, g.phone)
   from public.guests g
   where g.account_id = p_account_id and g.merged_into_id is null and length(btrim(p_query)) >= 2
     and (concat_ws(' ', g.first_name, g.last_name) ilike '%' || btrim(p_query) || '%'
          or g.email ilike '%' || btrim(p_query) || '%' or g.phone ilike '%' || btrim(p_query) || '%')
   order by g.last_name, g.first_name limit 10)
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

-- Reservations the caller may read: reservations.view within listing scope.
create or replace function private.can_view_reservation(p_account_id uuid, p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission(p_account_id, 'reservations.view')
     and exists (select 1 from public.listings l where l.id = p_listing_id
                 and private.can_access_listing(l.account_id, l.id, private.listing_scope_tags(l)))
$$;

alter table public.guests enable row level security;
alter table public.reservations enable row level security;
alter table public.reservation_lines enable row level security;
alter table public.reservation_payments enable row level security;
alter table public.reservation_activity enable row level security;
alter table public.reservation_notes enable row level security;
alter table public.reservation_files enable row level security;
alter table public.reservation_source_settings enable row level security;
alter table public.reservation_saved_views enable row level security;

revoke all on public.guests, public.reservations, public.reservation_lines, public.reservation_payments, public.reservation_activity,
  public.reservation_notes, public.reservation_files, public.reservation_source_settings, public.reservation_saved_views,
  public.reservation_balances from anon;
revoke insert, update, delete, truncate on public.reservations, public.reservation_lines, public.reservation_payments,
  public.reservation_activity, public.reservation_notes, public.reservation_files from authenticated;
revoke delete, truncate on public.guests, public.reservation_source_settings from authenticated;
revoke truncate on public.reservation_saved_views from authenticated;
grant select on public.reservation_balances to authenticated;

create policy guests_select on public.guests for select to authenticated
  using (private.has_permission(account_id, 'reservations.view'));
create policy guests_insert on public.guests for insert to authenticated
  with check (private.has_permission(account_id, 'reservations.create'));
create policy guests_update on public.guests for update to authenticated
  using (private.has_permission(account_id, 'reservations.edit'))
  with check (private.has_permission(account_id, 'reservations.edit'));

create policy reservations_select on public.reservations for select to authenticated
  using (private.can_view_reservation(account_id, listing_id));

create policy reservation_lines_select on public.reservation_lines for select to authenticated
  using (private.has_permission(account_id, 'reservations.view_money')
         and exists (select 1 from public.reservations r where r.id = reservation_id));
create policy reservation_payments_select on public.reservation_payments for select to authenticated
  using (private.has_permission(account_id, 'reservations.view_money')
         and exists (select 1 from public.reservations r where r.id = reservation_id));
create policy reservation_activity_select on public.reservation_activity for select to authenticated
  using (exists (select 1 from public.reservations r where r.id = reservation_id));
create policy reservation_notes_select on public.reservation_notes for select to authenticated
  using (exists (select 1 from public.reservations r where r.id = reservation_id));
create policy reservation_files_select on public.reservation_files for select to authenticated
  using (exists (select 1 from public.reservations r where r.id = reservation_id));

create policy reservation_source_settings_select on public.reservation_source_settings for select to authenticated
  using (private.has_permission(account_id, 'reservations.view'));
create policy reservation_source_settings_insert on public.reservation_source_settings for insert to authenticated
  with check (private.has_permission(account_id, 'reservations.manage'));
create policy reservation_source_settings_update on public.reservation_source_settings for update to authenticated
  using (private.has_permission(account_id, 'reservations.manage'))
  with check (private.has_permission(account_id, 'reservations.manage'));

create policy saved_views_select on public.reservation_saved_views for select to authenticated
  using (private.has_permission(account_id, 'reservations.view') and (user_id = (select auth.uid()) or shared));
create policy saved_views_insert on public.reservation_saved_views for insert to authenticated
  with check (private.has_permission(account_id, 'reservations.view') and user_id = (select auth.uid()));
create policy saved_views_update on public.reservation_saved_views for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_views_delete on public.reservation_saved_views for delete to authenticated
  using (user_id = (select auth.uid()));

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_reservation(uuid, date, date, public.reservation_status, uuid, jsonb, integer, integer, integer, integer, text, text, bigint, text, time, time, text[], text)',
    'public.confirm_reservation(uuid, public.reservation_status)',
    'public.decline_reservation(uuid, text)',
    'public.cancel_reservation(uuid, text, text, integer, boolean)',
    'public.expire_overdue_reservations()',
    'public.set_stay_status(uuid, public.stay_status)',
    'public.update_reservation_details(uuid, time, time, text[], boolean)',
    'public.alter_reservation(uuid, date, date, uuid, integer, integer, integer, integer, boolean, boolean, bigint, text)',
    'public.reassign_reservation_unit(uuid, uuid)',
    'public.add_reservation_line(uuid, text, text, bigint, text, integer)',
    'public.record_payment(uuid, bigint, text, timestamptz, text, text)',
    'public.add_reservation_note(uuid, text)',
    'public.register_reservation_file(uuid, text, text, text, bigint)',
    'public.merge_guests(uuid, uuid)',
    'public.get_calendar_bookings(uuid[], date, date)',
    'public.search_reservations(uuid, text, integer)',
    'public.global_search(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

revoke execute on function public.ingest_channel_reservation(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_channel_reservation(uuid, text, text, jsonb) to service_role;

revoke execute on all functions in schema private from public;
grant execute on function
  private.can_view_reservation(uuid, uuid),
  private.can_access_reservation_file_path(text, text),
  private.reservation_totals(uuid),
  private.is_channel_source(text)
to authenticated, service_role;

alter function public.get_calendar_bookings(uuid[], date, date) set jit = off;
alter function private.create_reservation_core(uuid, date, date, uuid, public.reservation_status, text, text, integer, integer, integer, integer, text, jsonb, bigint, bigint, text, timestamptz, time, time, text[]) set jit = off;
