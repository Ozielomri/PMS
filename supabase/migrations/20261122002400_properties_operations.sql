-- Step 3 / Properties operations:
--   PRP-13 multi-units: add / move / convert sub-units (removing = archiving, see 002200)
--   PRP-01 duplicate a listing
--   PRP-15 bulk edit across a selection
--   PRP-19 per-listing change log, readable with properties.view (no audit.view needed)
-- The integrity rules themselves live in triggers (002200); these RPCs add atomic multi-row
-- work on top and run the same checks.

-- ---------------------------------------------------------------------------
-- Content copy (used by convert and duplicate). Caller checks permissions.
-- ---------------------------------------------------------------------------

create or replace function private.copy_listing_content(p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid := (select account_id from public.listings where id = p_to);
begin
  create temporary table if not exists pg_temp.room_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  delete from pg_temp.room_map;
  insert into pg_temp.room_map (old_id, new_id)
  select r.id, gen_random_uuid() from public.listing_rooms r where r.listing_id = p_from;

  insert into public.listing_rooms (id, account_id, listing_id, name, room_type, beds, position)
  select m.new_id, v_account, p_to, r.name, r.room_type, r.beds, r.position
  from public.listing_rooms r join pg_temp.room_map m on m.old_id = r.id;

  insert into public.listing_amenities (account_id, listing_id, amenity_code, custom_label)
  select v_account, p_to, a.amenity_code, a.custom_label from public.listing_amenities a where a.listing_id = p_from;

  insert into public.listing_descriptions (account_id, listing_id, language, summary, space, neighborhood, transit, house_rules, access_notes)
  select v_account, p_to, d.language, d.summary, d.space, d.neighborhood, d.transit, d.house_rules, d.access_notes
  from public.listing_descriptions d where d.listing_id = p_from;

  insert into public.listing_photos (account_id, listing_id, storage_path, position, caption, room_id, content_type, size_bytes, width, height)
  select v_account, p_to, p.storage_path, p.position, p.caption, m.new_id, p.content_type, p.size_bytes, p.width, p.height
  from public.listing_photos p left join pg_temp.room_map m on m.old_id = p.room_id
  where p.listing_id = p_from;
end;
$$;

-- Copy the descriptive/booking columns of one listing onto another (not identity, status, structure).
create or replace function private.copy_listing_columns(p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.listings t set
    public_title = s.public_title, timezone = s.timezone, currency = s.currency,
    max_guests = s.max_guests, check_in_from = s.check_in_from, check_in_to = s.check_in_to, check_out_by = s.check_out_by,
    base_price_cents = s.base_price_cents, weekend_price_cents = s.weekend_price_cents, weekend_nights = s.weekend_nights,
    min_nights = s.min_nights, max_nights = s.max_nights, advance_notice_hours = s.advance_notice_hours,
    preparation_nights = s.preparation_nights, booking_window_days = s.booking_window_days, instant_book = s.instant_book,
    weekly_discount_bps = s.weekly_discount_bps, monthly_discount_bps = s.monthly_discount_bps,
    cleaning_fee_cents = s.cleaning_fee_cents, extra_guest_fee_cents = s.extra_guest_fee_cents,
    extra_guest_after = s.extra_guest_after, pet_fee_cents = s.pet_fee_cents,
    address_line1 = s.address_line1, address_line2 = s.address_line2, city = s.city, state_region = s.state_region,
    postal_code = s.postal_code, country_code = s.country_code, latitude = s.latitude, longitude = s.longitude,
    bedrooms = s.bedrooms, bathrooms_full = s.bathrooms_full, bathrooms_half = s.bathrooms_half, size_sqft = s.size_sqft,
    cancellation_policy = s.cancellation_policy, cancellation_policy_notes = s.cancellation_policy_notes,
    tags = s.tags || t.tags
  from public.listings s
  where s.id = p_from and t.id = p_to;
end;
$$;

create or replace function private.assert_manage(p_listing_id uuid)
returns public.listings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_listing public.listings := private.assert_can_on_listing(p_listing_id, 'properties.view');
begin
  if not private.has_permission(v_listing.account_id, 'properties.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_listing;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-13 multi-units
-- ---------------------------------------------------------------------------

-- Add sub-units to a parent. They are active right away when the parent is.
create or replace function public.add_sub_units(p_parent_id uuid, p_names text[])
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.listings := private.assert_manage(p_parent_id);
begin
  if v_parent.type <> 'multi_parent' then
    raise exception 'not_a_multi_unit_parent' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_names), 0) not between 1 and 200 then
    raise exception 'add between 1 and 200 sub-units at a time' using errcode = '22023';
  end if;
  return query
  insert into public.listings (account_id, type, parent_id, status, internal_name, created_by)
  select v_parent.account_id, 'sub_unit', v_parent.id,
         case when v_parent.status = 'active' then 'active' else 'draft' end::public.listing_status,
         btrim(n), auth.uid()
  from unnest(p_names) with ordinality as u(n, ord)
  order by ord
  returning id;
end;
$$;

-- Move a sub-unit to another parent. It keeps its own availability (calendar) and cleaning status.
create or replace function public.move_sub_unit(p_sub_unit_id uuid, p_new_parent_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.listings := private.assert_manage(p_sub_unit_id);
  v_parent public.listings := private.assert_manage(p_new_parent_id);
begin
  if v_sub.type <> 'sub_unit' then
    raise exception 'not_a_sub_unit' using errcode = '22023';
  end if;
  if v_parent.type <> 'multi_parent' or v_parent.account_id <> v_sub.account_id then
    raise exception 'not_a_multi_unit_parent' using errcode = '22023';
  end if;
  if v_parent.id = v_sub.parent_id then
    return;
  end if;
  update public.listings
  set parent_id = v_parent.id,
      status = case
        when status = 'archived' then 'archived'
        when v_parent.status = 'active' then status
        else 'draft' end::public.listing_status
  where id = v_sub.id;
end;
$$;

-- Turn a sub-unit into a standalone single unit, copying the parent's content and prices so it
-- is immediately complete. Its status, cleaning status, custom values and calendar stay.
create or replace function public.convert_sub_unit_to_single(p_sub_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.listings := private.assert_manage(p_sub_unit_id);
  v_parent_id uuid := v_sub.parent_id;
begin
  if v_sub.type <> 'sub_unit' then
    raise exception 'not_a_sub_unit' using errcode = '22023';
  end if;
  update public.listings set type = 'single', parent_id = null where id = v_sub.id;
  perform private.copy_listing_columns(v_parent_id, v_sub.id);
  perform private.copy_listing_content(v_parent_id, v_sub.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-01 duplicate
-- ---------------------------------------------------------------------------

-- New draft copy (content, prices, rules, non-secret custom values). A parent is copied with its
-- non-archived sub-units; a sub-unit is copied as a new sub-unit of the same parent. Secret values
-- are bound to the original row (encryption context) and are not copied.
create or replace function public.duplicate_listing(p_listing_id uuid, p_internal_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src public.listings := private.assert_manage(p_listing_id);
  v_new uuid;
begin
  if v_src.type = 'complex' then
    raise exception 'complexes cannot be duplicated' using errcode = '22023';
  end if;
  insert into public.listings (account_id, type, parent_id, status, internal_name, created_by)
  values (v_src.account_id, v_src.type, v_src.parent_id, 'draft',
          coalesce(nullif(btrim(p_internal_name), ''), left(v_src.internal_name, 192) || ' (copy)'), auth.uid())
  returning id into v_new;

  if v_src.type <> 'sub_unit' then
    update public.listings set tags = '{}' where id = v_new;
    perform private.copy_listing_columns(v_src.id, v_new);
    perform private.copy_listing_content(v_src.id, v_new);
  end if;
  update public.listings set cleaning_status = v_src.cleaning_status where id = v_new and v_src.type <> 'multi_parent';

  insert into public.listing_custom_values (account_id, listing_id, field_id, value_text, value_number, value_date)
  select v.account_id, v_new, v.field_id, v.value_text, v.value_number, v.value_date
  from public.listing_custom_values v
  where v.listing_id = v_src.id and v.value_secret_ciphertext is null;

  if v_src.type = 'multi_parent' then
    insert into public.listings (account_id, type, parent_id, status, internal_name, created_by)
    select s.account_id, 'sub_unit', v_new, 'draft', s.internal_name, auth.uid()
    from public.listings s
    where s.parent_id = v_src.id and s.status <> 'archived'
    order by s.created_at, s.id;
  end if;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-15 bulk edit (all or nothing)
-- ---------------------------------------------------------------------------

-- p_changes keys: base_price_cents, weekend_price_cents, min_nights, max_nights,
-- cleaning_fee_cents, extra_guest_fee_cents, extra_guest_after, pet_fee_cents,
-- check_in_from, check_in_to, check_out_by, add_tags, remove_tags, add_amenities, remove_amenities.
-- Security invoker: RLS (properties.edit, listing scope) applies to every row.
create or replace function public.bulk_update_listings(p_listing_ids uuid[], p_changes jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_keys text[] := array(select jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)));
  v_allowed text[] := array['base_price_cents', 'weekend_price_cents', 'min_nights', 'max_nights',
    'cleaning_fee_cents', 'extra_guest_fee_cents', 'extra_guest_after', 'pet_fee_cents',
    'check_in_from', 'check_in_to', 'check_out_by', 'add_tags', 'remove_tags', 'add_amenities', 'remove_amenities'];
  v_ids uuid[] := array(select distinct i from unnest(coalesce(p_listing_ids, '{}')) i);
  v_add_tags text[] := array(select jsonb_array_elements_text(coalesce(p_changes -> 'add_tags', '[]')));
  v_remove_tags text[] := array(select lower(btrim(t)) from jsonb_array_elements_text(coalesce(p_changes -> 'remove_tags', '[]')) t);
  v_add_amenities text[] := array(select jsonb_array_elements_text(coalesce(p_changes -> 'add_amenities', '[]')));
  v_remove_amenities text[] := array(select jsonb_array_elements_text(coalesce(p_changes -> 'remove_amenities', '[]')));
  v_count integer;
begin
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 1000 then
    raise exception 'select between 1 and 1000 listings' using errcode = '22023';
  end if;
  if cardinality(v_keys) = 0 or not (v_keys <@ v_allowed) then
    raise exception 'bulk_invalid_changes: allowed keys are %', array_to_string(v_allowed, ', ') using errcode = '22023';
  end if;
  if (select count(*) from public.listings where id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'not_found: some listings are not visible' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(v_keys) k where k not in ('add_tags', 'remove_tags'))
     and exists (select 1 from public.listings where id = any (v_ids) and type = 'sub_unit') then
    raise exception 'sub_units_inherit_from_parent: edit prices, rules, times and amenities on the parent' using errcode = '22023';
  end if;

  update public.listings l set
    base_price_cents = case when p_changes ? 'base_price_cents' then (p_changes ->> 'base_price_cents')::integer else l.base_price_cents end,
    weekend_price_cents = case when p_changes ? 'weekend_price_cents' then (p_changes ->> 'weekend_price_cents')::integer else l.weekend_price_cents end,
    min_nights = case when p_changes ? 'min_nights' then (p_changes ->> 'min_nights')::integer else l.min_nights end,
    max_nights = case when p_changes ? 'max_nights' then (p_changes ->> 'max_nights')::integer else l.max_nights end,
    cleaning_fee_cents = case when p_changes ? 'cleaning_fee_cents' then (p_changes ->> 'cleaning_fee_cents')::integer else l.cleaning_fee_cents end,
    extra_guest_fee_cents = case when p_changes ? 'extra_guest_fee_cents' then (p_changes ->> 'extra_guest_fee_cents')::integer else l.extra_guest_fee_cents end,
    extra_guest_after = case when p_changes ? 'extra_guest_after' then (p_changes ->> 'extra_guest_after')::integer else l.extra_guest_after end,
    pet_fee_cents = case when p_changes ? 'pet_fee_cents' then (p_changes ->> 'pet_fee_cents')::integer else l.pet_fee_cents end,
    check_in_from = case when p_changes ? 'check_in_from' then (p_changes ->> 'check_in_from')::time else l.check_in_from end,
    check_in_to = case when p_changes ? 'check_in_to' then (p_changes ->> 'check_in_to')::time else l.check_in_to end,
    check_out_by = case when p_changes ? 'check_out_by' then (p_changes ->> 'check_out_by')::time else l.check_out_by end,
    tags = array(select t from unnest(l.tags || v_add_tags) t where not (lower(btrim(t)) = any (v_remove_tags)))
  where l.id = any (v_ids);
  get diagnostics v_count = row_count;
  if v_count <> cardinality(v_ids) then
    raise exception 'forbidden: you cannot edit every selected listing' using errcode = '42501';
  end if;

  if cardinality(v_add_amenities) > 0 then
    insert into public.listing_amenities (account_id, listing_id, amenity_code)
    select l.account_id, l.id, c
    from public.listings l cross join unnest(v_add_amenities) c
    where l.id = any (v_ids)
    on conflict (listing_id, amenity_code) do nothing;
  end if;
  if cardinality(v_remove_amenities) > 0 then
    delete from public.listing_amenities a where a.listing_id = any (v_ids) and a.amenity_code = any (v_remove_amenities);
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRP-19 change log per listing (from the audit log, X-03)
-- ---------------------------------------------------------------------------

-- Child rows are linked to their listing through the listing_id in their insert entry (and delete
-- entry), so updates of rows that were later deleted still show up.
create index audit_log_listing_ref_idx on public.audit_log
  (account_id, (coalesce(diff -> 'listing_id' ->> 'new', diff -> 'listing_id' ->> 'old')))
  where entity_type in ('listing_rooms', 'listing_amenities', 'listing_descriptions', 'listing_photos',
                        'listing_custom_values', 'listing_channel_links');

create or replace function public.listing_change_log(p_listing_id uuid, p_before_id bigint default null, p_limit integer default 50)
returns table (
  id bigint,
  occurred_at timestamptz,
  actor_type text,
  actor_id text,
  actor_name text,
  entity_type text,
  entity_id text,
  action text,
  diff jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_listing public.listings := private.assert_can_on_listing(p_listing_id, 'properties.view');
begin
  return query
  select a.id, a.occurred_at, a.actor_type, a.actor_id,
         coalesce(p.full_name, p.email), a.entity_type, a.entity_id, a.action, a.diff
  from public.audit_log a
  left join public.profiles p on p.user_id = a.actor_user_id
  where a.account_id = v_listing.account_id
    and (p_before_id is null or a.id < p_before_id)
    and (
      (a.entity_type = 'listings' and a.entity_id = v_listing.id::text)
      or (a.entity_type, a.entity_id) in (
        select r.entity_type, r.entity_id
        from public.audit_log r
        where r.account_id = v_listing.account_id
          and r.entity_type in ('listing_rooms', 'listing_amenities', 'listing_descriptions', 'listing_photos',
                                'listing_custom_values', 'listing_channel_links')
          and coalesce(r.diff -> 'listing_id' ->> 'new', r.diff -> 'listing_id' ->> 'old') = v_listing.id::text
      )
    )
  order by a.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.add_sub_units(uuid, text[])',
    'public.move_sub_unit(uuid, uuid)',
    'public.convert_sub_unit_to_single(uuid)',
    'public.duplicate_listing(uuid, text)',
    'public.bulk_update_listings(uuid[], jsonb)',
    'public.listing_change_log(uuid, bigint, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

revoke execute on all functions in schema private from public;
