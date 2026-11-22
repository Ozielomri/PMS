-- Steps 2 + 3 shared contract: the core `listings` table that both the Calendar engine and the
-- Properties module build on. See docs/plans/step-2-3-contract.md.
--
--   * Properties (PRP-*) owns everything descriptive and may ADD columns/tables around this one.
--   * Calendar (CAL-*) reads the booking columns below and owns all availability and nightly data.
--   * Neither side renames or drops columns defined here without updating the contract.
--
-- Multi-units: a `multi_parent` row holds content, prices, fees and rules; its `sub_unit` children
-- (parent_id) hold only their own availability and cleaning status. For a sub-unit, every booking
-- and pricing column below is ignored in favour of the parent's.

create type public.listing_type as enum ('single', 'multi_parent', 'sub_unit', 'complex');
create type public.listing_status as enum ('draft', 'active', 'archived');

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  type public.listing_type not null default 'single',
  parent_id uuid,
  status public.listing_status not null default 'draft',
  internal_name text not null check (length(btrim(internal_name)) between 1 and 200),
  public_title text check (public_title is null or length(public_title) <= 500),
  timezone text not null default 'America/New_York',
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  tags text[] not null default '{}',
  max_guests integer check (max_guests is null or max_guests between 1 and 100),

  -- PRP-07 default times (local time in the listing timezone)
  check_in_from time,
  check_in_to time,
  check_out_by time,

  -- PRP-08 booking defaults. Money is integer cents in `currency`.
  base_price_cents integer check (base_price_cents is null or base_price_cents >= 0),
  weekend_price_cents integer check (weekend_price_cents is null or weekend_price_cents >= 0),
  -- Nights (Postgres dow of the night's date, 0 = Sunday) that use weekend_price_cents: Fri, Sat.
  weekend_nights smallint[] not null default '{5,6}',
  min_nights integer not null default 1 check (min_nights >= 1),
  max_nights integer check (max_nights is null or max_nights >= 1),
  advance_notice_hours integer not null default 0 check (advance_notice_hours between 0 and 8760),
  preparation_nights integer not null default 0 check (preparation_nights between 0 and 30),
  booking_window_days integer not null default 730 check (booking_window_days between 1 and 1095),
  instant_book boolean not null default true,

  -- CAL-05 length-of-stay discounts, in basis points (1000 = 10 %)
  weekly_discount_bps integer not null default 0 check (weekly_discount_bps between 0 and 10000),
  monthly_discount_bps integer not null default 0 check (monthly_discount_bps between 0 and 10000),

  -- PRP-09 fees (no tourist tax in this phase), snapshotted onto reservations later
  cleaning_fee_cents integer not null default 0 check (cleaning_fee_cents >= 0),
  extra_guest_fee_cents integer not null default 0 check (extra_guest_fee_cents >= 0),
  extra_guest_after integer check (extra_guest_after is null or extra_guest_after >= 1),
  pet_fee_cents integer not null default 0 check (pet_fee_cents >= 0),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,

  unique (id, account_id),
  foreign key (parent_id, account_id) references public.listings (id, account_id),
  constraint listings_parent_matches_type check (
    (type = 'sub_unit' and parent_id is not null) or (type <> 'sub_unit' and parent_id is null)
  ),
  constraint listings_min_le_max check (max_nights is null or max_nights >= min_nights),
  constraint listings_weekend_nights_valid check (weekend_nights <@ '{0,1,2,3,4,5,6}'::smallint[])
);

comment on table public.listings is
  'Bookable units and their parents (PRP). Core columns are a contract between Properties and Calendar.';

create index listings_account_idx on public.listings (account_id, status);
create index listings_parent_idx on public.listings (parent_id) where parent_id is not null;
create index listings_tags_idx on public.listings using gin (tags);

-- A sub-unit's parent must be a multi_parent.
create or replace function private.validate_listing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from public.listings p where p.id = new.parent_id and p.type = 'multi_parent'
  ) then
    raise exception 'parent of a sub_unit must be a multi_parent listing' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger listings_validate before insert or update of timezone, parent_id, type on public.listings
  for each row execute function private.validate_listing();
create trigger listings_touch before update on public.listings
  for each row execute function private.touch_updated_at();

create trigger audit_listings after insert or update or delete on public.listings
  for each row execute function private.audit_row_change();
create trigger events_listings after insert or update on public.listings
  for each row execute function private.emit_row_event('listing');

-- Tags a listing is matched on for listing scope (X-01): its own plus its parent's.
create or replace function private.listing_scope_tags(p_listing public.listings)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select p_listing.tags || coalesce((select p.tags from public.listings p where p.id = p_listing.parent_id), '{}')
$$;

alter table public.listings enable row level security;
revoke all on public.listings from anon;
revoke delete, truncate on public.listings from authenticated;

-- Read: properties.view (or calendar.view) within the member's listing scope.
create policy listings_select on public.listings
  for select to authenticated
  using (
    (private.has_permission(account_id, 'properties.view') or private.has_permission(account_id, 'calendar.view'))
    and private.can_access_listing(account_id, id, private.listing_scope_tags(listings))
  );

-- Create: properties.manage (admins only, decided 22 Nov 2026).
create policy listings_insert on public.listings
  for insert to authenticated
  with check (private.has_permission(account_id, 'properties.manage'));

-- Edit: properties.edit within scope. Archiving rules are enforced by the Properties module.
create policy listings_update on public.listings
  for update to authenticated
  using (private.has_permission(account_id, 'properties.edit') and private.can_access_listing(account_id, id, private.listing_scope_tags(listings)))
  with check (private.has_permission(account_id, 'properties.edit'));

grant execute on function private.listing_scope_tags(public.listings) to authenticated;
revoke execute on all functions in schema private from public;

-- Contract stub, replaced by the Calendar migrations (step 2): does the listing (or, for a
-- multi_parent, any of its sub-units) have reservation or owner-stay holds on future nights?
create or replace function public.listing_has_future_bookings(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false
$$;

revoke execute on function public.listing_has_future_bookings(uuid) from public, anon;
grant execute on function public.listing_has_future_bookings(uuid) to authenticated, service_role;
