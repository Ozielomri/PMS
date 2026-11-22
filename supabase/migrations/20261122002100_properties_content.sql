-- Step 3 / Properties (PRP-02 … PRP-06, PRP-10, PRP-16, PRP-17): descriptive listing columns and
-- content tables. See docs/plans/step-3-properties.md. The contract table public.listings is
-- extended here (new columns only); its contract columns are untouched.

-- ---------------------------------------------------------------------------
-- New listing columns
-- ---------------------------------------------------------------------------

create type public.cleaning_status as enum ('clean', 'dirty', 'inspected', 'in_progress');

alter table public.listings
  -- PRP-02 address with geo-coordinates
  add column address_line1 text check (address_line1 is null or length(address_line1) <= 200),
  add column address_line2 text check (address_line2 is null or length(address_line2) <= 200),
  add column city text check (city is null or length(city) <= 100),
  add column state_region text check (state_region is null or length(state_region) <= 100),
  add column postal_code text check (postal_code is null or length(postal_code) <= 20),
  add column country_code char(2) not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  add column latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  add column longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  -- PRP-03 capacity (beds by type live on listing_rooms)
  add column bedrooms integer check (bedrooms is null or bedrooms between 0 and 100),
  add column bathrooms_full integer check (bathrooms_full is null or bathrooms_full between 0 and 100),
  add column bathrooms_half integer check (bathrooms_half is null or bathrooms_half between 0 and 100),
  add column size_sqft integer check (size_sqft is null or size_sqft between 1 and 1000000),
  -- PRP-10 cancellation policy (a selectable value; refund rules come with reservations)
  add column cancellation_policy text not null default 'moderate'
    check (cancellation_policy in ('flexible', 'moderate', 'strict', 'non_refundable', 'custom')),
  add column cancellation_policy_notes text check (cancellation_policy_notes is null or length(cancellation_policy_notes) <= 5000),
  -- PRP-16 cleaning status per unit (null on multi_parent / complex)
  add column cleaning_status public.cleaning_status,
  add column cleaning_status_updated_at timestamptz;

create index listings_city_idx on public.listings (account_id, lower(city));

-- ---------------------------------------------------------------------------
-- Shared helpers for listing content tables
-- ---------------------------------------------------------------------------

-- Content (rooms, amenities, descriptions, photos) lives on the parent of a multi-unit.
create or replace function private.guard_listing_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.listings l where l.id = new.listing_id and l.type = 'sub_unit') then
    raise exception 'sub_unit_content_on_parent: edit content on the multi-unit parent' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- "listing.content_updated" for changes to a listing's content rows. Argument 1 = section name,
-- further arguments = columns left out of the payload (secrets).
create or replace function private.emit_listing_content_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text := tg_argv[0];
  v_hidden text[] := coalesce(tg_argv[1:], '{}');
  v_row jsonb := to_jsonb(coalesce(new, old)) - v_hidden;
  v_changes jsonb;
begin
  if tg_op = 'UPDATE' then
    v_changes := private.row_diff(to_jsonb(old) - v_hidden, to_jsonb(new) - v_hidden);
    if v_changes = '{}'::jsonb and v_hidden = '{}' then
      return null;
    end if;
  end if;
  perform private.emit_event(
    (v_row ->> 'account_id')::uuid,
    'listing.content_updated',
    'listing',
    v_row ->> 'listing_id',
    jsonb_build_object('section', v_section, 'action', lower(tg_op), 'record_id', v_row ->> 'id', 'changes', v_changes)
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-03 rooms and beds
-- ---------------------------------------------------------------------------

create table public.listing_rooms (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  room_type text not null default 'bedroom'
    check (room_type in ('bedroom', 'living_room', 'bathroom', 'kitchen', 'dining_room', 'outdoor', 'other')),
  -- Beds by type: {"king": 1, "sofa_bed": 1}. Keys validated by trigger.
  beds jsonb not null default '{}'::jsonb check (jsonb_typeof(beds) = 'object'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  unique (id, listing_id)
);

create index listing_rooms_listing_idx on public.listing_rooms (listing_id, position);

create or replace function private.validate_listing_room()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
begin
  for v_key, v_value in select * from jsonb_each(new.beds) loop
    if v_key not in ('king', 'queen', 'double', 'single', 'sofa_bed', 'bunk_bed', 'crib', 'air_mattress', 'futon') then
      raise exception 'invalid bed type: %', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric not between 0 and 50
       or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric) then
      raise exception 'invalid bed count for %', v_key using errcode = '22023';
    end if;
  end loop;
  -- Drop zero counts so the jsonb stays canonical.
  new.beds := coalesce((select jsonb_object_agg(k, v) from jsonb_each(new.beds) e(k, v) where (v #>> '{}')::numeric > 0), '{}'::jsonb);
  return new;
end;
$$;

create trigger listing_rooms_guard before insert or update of listing_id on public.listing_rooms
  for each row execute function private.guard_listing_content();
create trigger listing_rooms_validate before insert or update on public.listing_rooms
  for each row execute function private.validate_listing_room();
create trigger listing_rooms_touch before update on public.listing_rooms
  for each row execute function private.touch_updated_at();
create trigger audit_listing_rooms after insert or update or delete on public.listing_rooms
  for each row execute function private.audit_row_change();
create trigger events_listing_rooms after insert or update or delete on public.listing_rooms
  for each row execute function private.emit_listing_content_event('rooms');

-- ---------------------------------------------------------------------------
-- PRP-04 amenities: global master list + per-listing selection
-- ---------------------------------------------------------------------------

-- Reference data (not account data), like role_permissions. `ota_codes` maps to channel codes,
-- e.g. {"booking_com": "107"}; filled in step 9 from the Booking.com Connectivity API docs.
create table public.amenities (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  label text not null,
  category text not null,
  ota_codes jsonb not null default '{}'::jsonb,
  sort integer not null default 0
);

insert into public.amenities (code, label, category, sort) values
  ('wifi', 'Wi-Fi', 'essentials', 10),
  ('air_conditioning', 'Air conditioning', 'essentials', 20),
  ('heating', 'Heating', 'essentials', 30),
  ('essentials', 'Towels, bed sheets, soap, toilet paper', 'essentials', 40),
  ('hot_water', 'Hot water', 'essentials', 50),
  ('workspace', 'Dedicated workspace', 'essentials', 60),
  ('tv', 'TV', 'entertainment', 100),
  ('streaming', 'Streaming services', 'entertainment', 110),
  ('kitchen', 'Kitchen', 'kitchen', 200),
  ('refrigerator', 'Refrigerator', 'kitchen', 210),
  ('microwave', 'Microwave', 'kitchen', 220),
  ('oven', 'Oven', 'kitchen', 230),
  ('stove', 'Stove', 'kitchen', 240),
  ('dishwasher', 'Dishwasher', 'kitchen', 250),
  ('coffee_maker', 'Coffee maker', 'kitchen', 260),
  ('cookware', 'Cooking basics', 'kitchen', 270),
  ('washer', 'Washer', 'laundry', 300),
  ('dryer', 'Dryer', 'laundry', 310),
  ('iron', 'Iron', 'laundry', 320),
  ('hair_dryer', 'Hair dryer', 'bathroom', 400),
  ('bathtub', 'Bathtub', 'bathroom', 410),
  ('free_parking', 'Free parking on premises', 'parking', 500),
  ('street_parking', 'Free street parking', 'parking', 510),
  ('paid_parking', 'Paid parking', 'parking', 520),
  ('ev_charger', 'EV charger', 'parking', 530),
  ('pool', 'Pool', 'outdoor', 600),
  ('hot_tub', 'Hot tub', 'outdoor', 610),
  ('patio', 'Patio or balcony', 'outdoor', 620),
  ('bbq_grill', 'BBQ grill', 'outdoor', 630),
  ('garden', 'Garden', 'outdoor', 640),
  ('beach_access', 'Beach access', 'outdoor', 650),
  ('gym', 'Gym', 'facilities', 700),
  ('elevator', 'Elevator', 'facilities', 710),
  ('self_check_in', 'Self check-in', 'facilities', 720),
  ('keypad', 'Keypad / smart lock', 'facilities', 730),
  ('crib', 'Crib', 'family', 800),
  ('high_chair', 'High chair', 'family', 810),
  ('pets_allowed', 'Pets allowed', 'policies', 900),
  ('smoking_allowed', 'Smoking allowed', 'policies', 910),
  ('events_allowed', 'Events allowed', 'policies', 920),
  ('wheelchair_accessible', 'Wheelchair accessible', 'accessibility', 1000),
  ('step_free_entrance', 'Step-free entrance', 'accessibility', 1010),
  ('smoke_alarm', 'Smoke alarm', 'safety', 1100),
  ('carbon_monoxide_alarm', 'Carbon monoxide alarm', 'safety', 1110),
  ('fire_extinguisher', 'Fire extinguisher', 'safety', 1120),
  ('first_aid_kit', 'First aid kit', 'safety', 1130),
  ('security_cameras', 'Exterior security cameras', 'safety', 1140);

create table public.listing_amenities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  amenity_code text references public.amenities (code),
  custom_label text check (custom_label is null or length(btrim(custom_label)) between 1 and 100),
  created_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  constraint listing_amenities_code_or_custom check (num_nonnulls(amenity_code, custom_label) = 1),
  unique (listing_id, amenity_code)
);

create unique index listing_amenities_custom_uniq on public.listing_amenities (listing_id, lower(custom_label))
  where custom_label is not null;

create trigger listing_amenities_guard before insert or update of listing_id on public.listing_amenities
  for each row execute function private.guard_listing_content();
create trigger audit_listing_amenities after insert or update or delete on public.listing_amenities
  for each row execute function private.audit_row_change();
create trigger events_listing_amenities after insert or update or delete on public.listing_amenities
  for each row execute function private.emit_listing_content_event('amenities');

-- ---------------------------------------------------------------------------
-- PRP-05 descriptions, one row per language
-- ---------------------------------------------------------------------------

create table public.listing_descriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  language text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  summary text check (summary is null or length(summary) <= 10000),
  space text check (space is null or length(space) <= 10000),
  neighborhood text check (neighborhood is null or length(neighborhood) <= 10000),
  transit text check (transit is null or length(transit) <= 10000),
  house_rules text check (house_rules is null or length(house_rules) <= 10000),
  access_notes text check (access_notes is null or length(access_notes) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  unique (listing_id, language)
);

create trigger listing_descriptions_guard before insert or update of listing_id on public.listing_descriptions
  for each row execute function private.guard_listing_content();
create trigger listing_descriptions_touch before update on public.listing_descriptions
  for each row execute function private.touch_updated_at();
create trigger audit_listing_descriptions after insert or update or delete on public.listing_descriptions
  for each row execute function private.audit_row_change();
create trigger events_listing_descriptions after insert or update or delete on public.listing_descriptions
  for each row execute function private.emit_listing_content_event('descriptions');

-- ---------------------------------------------------------------------------
-- PRP-06 photos (files in Supabase Storage bucket `listing-photos`, metadata here)
-- ---------------------------------------------------------------------------

create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  -- "<account_id>/<listing_id>/<file>". A duplicated listing reuses the original's path.
  storage_path text not null check (length(storage_path) <= 500 and storage_path !~ '\.\.'),
  position integer not null,
  caption text check (caption is null or length(caption) <= 500),
  room_id uuid,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  size_bytes bigint not null check (size_bytes between 1 and 26214400), -- 25 MB
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  -- A photo's room must belong to the same listing; deleting the room unassigns the photo.
  foreign key (room_id, listing_id) references public.listing_rooms (id, listing_id) on delete set null (room_id),
  constraint listing_photos_path_in_account check (starts_with(storage_path, account_id::text || '/')),
  constraint listing_photos_position_uniq unique (listing_id, position) deferrable initially deferred
);

create index listing_photos_path_idx on public.listing_photos (storage_path);

-- New photos go to the end.
create or replace function private.listing_photo_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.position is null then
    select coalesce(max(p.position) + 1, 0) into new.position
    from public.listing_photos p where p.listing_id = new.listing_id;
  end if;
  return new;
end;
$$;

create trigger listing_photos_guard before insert or update of listing_id on public.listing_photos
  for each row execute function private.guard_listing_content();
create trigger listing_photos_defaults before insert on public.listing_photos
  for each row execute function private.listing_photo_defaults();
create trigger listing_photos_touch before update on public.listing_photos
  for each row execute function private.touch_updated_at();
create trigger audit_listing_photos after insert or update or delete on public.listing_photos
  for each row execute function private.audit_row_change();
create trigger events_listing_photos after insert or update or delete on public.listing_photos
  for each row execute function private.emit_listing_content_event('photos');

-- Reorder in one statement: p_photo_ids must be exactly the listing's photos, in the new order.
create or replace function public.reorder_listing_photos(p_listing_id uuid, p_photo_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.listing_photos p where p.listing_id = p_listing_id)
     <> cardinality(p_photo_ids)
     or exists (
       select 1 from unnest(p_photo_ids) i
       where not exists (select 1 from public.listing_photos p where p.id = i and p.listing_id = p_listing_id)
     )
     or (select count(distinct i) from unnest(p_photo_ids) i) <> cardinality(p_photo_ids) then
    raise exception 'photo_order_mismatch: pass every photo of the listing exactly once' using errcode = '22023';
  end if;

  update public.listing_photos p
  set position = o.ord - 1
  from unnest(p_photo_ids) with ordinality as o(id, ord)
  where p.id = o.id and p.position is distinct from o.ord - 1;
end;
$$;

-- Storage path check used by the storage.objects policies: "<account>/<listing>/<file>" where
-- the caller may edit that listing.
create or replace function private.can_edit_listing_photo_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_name, '/');
  v_listing public.listings;
begin
  if cardinality(v_parts) <> 3
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[3] !~ '^[A-Za-z0-9_-]{1,100}\.(jpe?g|png|heic|heif)$' then
    return false;
  end if;
  select * into v_listing from public.listings l where l.id = v_parts[2]::uuid and l.account_id = v_parts[1]::uuid;
  if not found then
    return false;
  end if;
  return private.has_permission(v_listing.account_id, 'properties.edit')
     and private.can_access_listing(v_listing.account_id, v_listing.id, private.listing_scope_tags(v_listing));
end;
$$;

-- Bucket and policies exist only on Supabase (the test database has no storage schema).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('listing-photos', 'listing-photos', true, 26214400,
            array['image/jpeg', 'image/png', 'image/heic', 'image/heif'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists listing_photos_insert on storage.objects';
    execute 'drop policy if exists listing_photos_update on storage.objects';
    execute 'drop policy if exists listing_photos_delete on storage.objects';
    execute $p$create policy listing_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'listing-photos' and private.can_edit_listing_photo_path(name))$p$;
    execute $p$create policy listing_photos_update on storage.objects for update to authenticated
      using (bucket_id = 'listing-photos' and private.can_edit_listing_photo_path(name))
      with check (bucket_id = 'listing-photos' and private.can_edit_listing_photo_path(name))$p$;
    execute $p$create policy listing_photos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'listing-photos' and private.can_edit_listing_photo_path(name))$p$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-17 channel links (read-only for clients; written by the channel integration, step 9)
-- ---------------------------------------------------------------------------

create table public.listing_channel_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  channel text not null check (channel in ('booking_com')),
  external_listing_id text check (external_listing_id is null or length(external_listing_id) <= 200),
  sync_mode text not null default 'full' check (sync_mode in ('full', 'availability_and_rates', 'availability_only', 'paused')),
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  last_sync_at timestamptz,
  last_sync_error text check (last_sync_error is null or length(last_sync_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  unique (listing_id, channel)
);

create trigger listing_channel_links_touch before update on public.listing_channel_links
  for each row execute function private.touch_updated_at();
create trigger audit_listing_channel_links after insert or update or delete on public.listing_channel_links
  for each row execute function private.audit_row_change();
create trigger events_listing_channel_links after insert or update on public.listing_channel_links
  for each row execute function private.emit_row_event('listing_channel_link');

-- ---------------------------------------------------------------------------
-- Row Level Security. "The listing is visible" (exists … from listings) applies the listing's
-- own policy, i.e. the member's listing scope (X-01).
-- ---------------------------------------------------------------------------

alter table public.listing_rooms enable row level security;
alter table public.amenities enable row level security;
alter table public.listing_amenities enable row level security;
alter table public.listing_descriptions enable row level security;
alter table public.listing_photos enable row level security;
alter table public.listing_channel_links enable row level security;

revoke all on public.listing_rooms, public.amenities, public.listing_amenities, public.listing_descriptions,
  public.listing_photos, public.listing_channel_links from anon;
revoke truncate on public.listing_rooms, public.listing_amenities, public.listing_descriptions, public.listing_photos
  from authenticated;
revoke insert, update, delete, truncate on public.amenities, public.listing_channel_links from authenticated;

create policy amenities_read on public.amenities for select to authenticated using (true);

create policy listing_channel_links_select on public.listing_channel_links
  for select to authenticated
  using (private.has_permission(account_id, 'properties.view')
         and exists (select 1 from public.listings l where l.id = listing_id));

do $$
declare
  t text;
begin
  foreach t in array array['listing_rooms', 'listing_amenities', 'listing_descriptions', 'listing_photos'] loop
    execute format($f$
      create policy %1$s_select on public.%1$s for select to authenticated
        using (private.has_permission(account_id, 'properties.view')
               and exists (select 1 from public.listings l where l.id = listing_id))$f$, t);
    execute format($f$
      create policy %1$s_insert on public.%1$s for insert to authenticated
        with check (private.has_permission(account_id, 'properties.edit')
                    and exists (select 1 from public.listings l where l.id = listing_id and l.account_id = %1$s.account_id))$f$, t);
    execute format($f$
      create policy %1$s_update on public.%1$s for update to authenticated
        using (private.has_permission(account_id, 'properties.edit')
               and exists (select 1 from public.listings l where l.id = listing_id))
        with check (private.has_permission(account_id, 'properties.edit')
                    and exists (select 1 from public.listings l where l.id = listing_id and l.account_id = %1$s.account_id))$f$, t);
    execute format($f$
      create policy %1$s_delete on public.%1$s for delete to authenticated
        using (private.has_permission(account_id, 'properties.edit')
               and exists (select 1 from public.listings l where l.id = listing_id))$f$, t);
  end loop;
end;
$$;

revoke execute on function public.reorder_listing_photos(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_listing_photos(uuid, uuid[]) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on function private.can_edit_listing_photo_path(text) to authenticated, service_role;
