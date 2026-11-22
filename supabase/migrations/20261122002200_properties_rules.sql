-- Step 3 / Properties: business rules on public.listings, enforced in the database.
--   * activation requirements (deferred constraint triggers, checked at commit)
--   * archive blocked with future bookings; archive/restore and structure changes need properties.manage
--   * timezone change with future bookings needs explicit confirmation
--   * multi-unit structure: sub-units inherit timezone/currency; parent status cascades
--   * cleaning status per unit (PRP-16); tags normalised (PRP-11)
-- Future bookings come from Calendar's public.listing_has_future_bookings() (contract).

-- ---------------------------------------------------------------------------
-- Activation requirements
-- ---------------------------------------------------------------------------

-- Missing items that keep a listing from being active (empty array = activatable).
create or replace function private.listing_activation_problems(p_listing_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.listings;
  v_parent public.listings;
  v_problems text[] := '{}';
begin
  select * into l from public.listings where id = p_listing_id;
  if not found then
    return array['not_found'];
  end if;

  if l.type = 'complex' then
    return array['not_bookable'];
  end if;

  if l.type = 'sub_unit' then
    select * into v_parent from public.listings where id = l.parent_id;
    v_problems := array_remove(private.listing_activation_problems(v_parent.id), 'sub_units');
    if v_parent.status <> 'active' then
      v_problems := v_problems || 'parent_not_active'::text;
    end if;
    return v_problems;
  end if;

  if nullif(btrim(l.address_line1), '') is null or nullif(btrim(l.city), '') is null
     or nullif(btrim(l.postal_code), '') is null or l.country_code is null then
    v_problems := v_problems || 'address'::text;
  end if;
  if l.timezone is null then
    v_problems := v_problems || 'timezone'::text;
  end if;
  if l.max_guests is null or l.bedrooms is null or l.bathrooms_full is null then
    v_problems := v_problems || 'capacity'::text;
  end if;
  if coalesce(l.base_price_cents, 0) <= 0 then
    v_problems := v_problems || 'base_price'::text;
  end if;
  if l.check_in_from is null or l.check_out_by is null then
    v_problems := v_problems || 'check_in_out_times'::text;
  end if;
  if not exists (select 1 from public.listing_photos p where p.listing_id = l.id) then
    v_problems := v_problems || 'photo'::text;
  end if;
  if l.type = 'multi_parent' and not exists (
    select 1 from public.listings s where s.parent_id = l.id and s.status <> 'archived'
  ) then
    v_problems := v_problems || 'sub_units'::text;
  end if;
  return v_problems;
end;
$$;

create or replace function private.assert_activatable(p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problems text[];
begin
  if (select status from public.listings where id = p_listing_id) = 'active' then
    v_problems := private.listing_activation_problems(p_listing_id);
    if cardinality(v_problems) > 0 then
      raise exception 'listing_not_activatable: %', array_to_string(v_problems, ', ')
        using errcode = '23514', detail = array_to_string(v_problems, ',');
    end if;
  end if;
end;
$$;

-- Deferred: runs at commit on the final state, so a wizard can add photos and activate in one go.
create or replace function private.check_listing_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'listings' then
    perform private.assert_activatable(new.id);
    -- A sub-unit leaving (archived, moved, converted) may leave an active parent without units.
    if tg_op = 'UPDATE' and old.parent_id is not null then
      perform private.assert_activatable(old.parent_id);
    end if;
  else -- listing_photos
    perform private.assert_activatable(coalesce(old.listing_id, new.listing_id));
    perform private.assert_activatable(s.id) from public.listings s
      where s.parent_id = coalesce(old.listing_id, new.listing_id) and s.status = 'active';
  end if;
  return null;
end;
$$;

create constraint trigger listings_activation_check
  after insert or update on public.listings
  deferrable initially deferred
  for each row execute function private.check_listing_activation();

create constraint trigger listing_photos_activation_check
  after delete or update of listing_id on public.listing_photos
  deferrable initially deferred
  for each row execute function private.check_listing_activation();

-- For the UI checklist. Same visibility as the listing itself.
create or replace function public.listing_activation_problems(p_listing_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_listing public.listings;
begin
  select * into v_listing from public.listings where id = p_listing_id;
  if not found
     or not private.has_permission(v_listing.account_id, 'properties.view')
     or not private.can_access_listing(v_listing.account_id, v_listing.id, private.listing_scope_tags(v_listing)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return private.listing_activation_problems(p_listing_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row rules (before insert / update)
-- ---------------------------------------------------------------------------

-- Trim, drop empty and de-duplicate tags case-insensitively (first spelling wins).
create or replace function private.normalize_tags(p_tags text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(t order by ord), '{}')
  from (
    select distinct on (lower(btrim(t))) btrim(t) as t, ord
    from unnest(coalesce(p_tags, '{}')) with ordinality as u(t, ord)
    where btrim(t) <> ''
    order by lower(btrim(t)), ord
  ) x
$$;

create or replace function private.is_client_request()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(private.request_role() in ('authenticated', 'anon'), false)
$$;

create or replace function private.listing_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.listings;
  v_structure_changed boolean;
begin
  new.tags := private.normalize_tags(new.tags);
  if array_length(new.tags, 1) > 50 or exists (select 1 from unnest(new.tags) t where length(t) > 50) then
    raise exception 'too many or too long tags (max 50 tags of 50 characters)' using errcode = '22023';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.status = 'archived' then
      raise exception 'a new listing cannot be archived' using errcode = '22023';
    end if;
    new.archived_at := null;
  else
    if new.account_id <> old.account_id or new.id <> old.id then
      raise exception 'listing account cannot change' using errcode = '42501';
    end if;

    -- Structure (PRP-13): only sub_unit -> single (convert) and moving a sub-unit between parents.
    v_structure_changed := new.type <> old.type or new.parent_id is distinct from old.parent_id;
    if v_structure_changed then
      if new.type <> old.type and not (old.type = 'sub_unit' and new.type = 'single') then
        raise exception 'listing_type_change_not_allowed: % to %', old.type, new.type using errcode = '22023';
      end if;
      if private.is_client_request() and not private.has_permission(new.account_id, 'properties.manage') then
        raise exception 'forbidden: changing multi-unit structure needs properties.manage' using errcode = '42501';
      end if;
      if public.listing_has_future_bookings(old.id) then
        raise exception 'listing_has_future_bookings: move or cancel the future bookings of this sub-unit first'
          using errcode = 'P0001';
      end if;
    end if;

    -- Status (PRP-01): archive / restore need properties.manage; archive needs no future bookings.
    if new.status <> old.status then
      if (new.status = 'archived' or old.status = 'archived')
         and private.is_client_request()
         and not private.has_permission(new.account_id, 'properties.manage') then
        raise exception 'forbidden: archiving needs properties.manage' using errcode = '42501';
      end if;
      if old.status = 'archived' and new.status <> 'draft' then
        raise exception 'an archived listing is restored to draft first' using errcode = '22023';
      end if;
      if new.status = 'archived' then
        if public.listing_has_future_bookings(old.id) then
          raise exception 'listing_has_future_bookings: move or cancel future reservations before archiving'
            using errcode = 'P0001';
        end if;
        new.archived_at := now();
      elsif old.status = 'archived' then
        new.archived_at := null;
      end if;
    end if;

    -- Timezone with future bookings: only through change_listing_timezone(..., confirm => true).
    if new.timezone <> old.timezone and new.type <> 'sub_unit'
       and coalesce(current_setting('pms.confirm_timezone_change', true), '') <> old.id::text
       and public.listing_has_future_bookings(old.id) then
      raise exception 'timezone_change_requires_confirmation: the listing has future bookings'
        using errcode = 'P0001';
    end if;
  end if;

  -- Sub-units carry their parent's timezone and currency; new sub-units need a live parent.
  if new.type = 'sub_unit' then
    select * into v_parent from public.listings where id = new.parent_id;
    if found then
      if v_parent.status = 'archived' and new.status <> 'archived'
         and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or old.status = 'archived') then
        raise exception 'parent_archived: the multi-unit parent is archived' using errcode = '22023';
      end if;
      new.timezone := v_parent.timezone;
      new.currency := v_parent.currency;
    end if;
  end if;

  -- PRP-16: cleaning status belongs to units only.
  if new.type in ('multi_parent', 'complex') then
    new.cleaning_status := null;
    new.cleaning_status_updated_at := null;
  else
    new.cleaning_status := coalesce(new.cleaning_status, 'clean');
    if tg_op = 'INSERT' or new.cleaning_status is distinct from old.cleaning_status then
      new.cleaning_status_updated_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger listings_rules before insert or update on public.listings
  for each row execute function private.listing_rules();

-- ---------------------------------------------------------------------------
-- After update: cascades to sub-units and specific events
-- ---------------------------------------------------------------------------

create or replace function private.listing_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    return null;
  end if;
  if new.status <> old.status then
    perform private.emit_event(new.account_id, 'listing.status_changed', 'listing', new.id::text,
      jsonb_build_object('from', old.status, 'to', new.status, 'type', new.type, 'parent_id', new.parent_id));
  end if;
  if new.cleaning_status is distinct from old.cleaning_status and new.cleaning_status is not null then
    perform private.emit_event(new.account_id, 'listing.cleaning_status_changed', 'listing', new.id::text,
      jsonb_build_object('from', old.cleaning_status, 'to', new.cleaning_status, 'parent_id', new.parent_id));
  end if;

  if new.type = 'multi_parent' then
    if new.status <> old.status then
      if new.status = 'archived' then
        update public.listings set status = 'archived' where parent_id = new.id and status <> 'archived';
      elsif new.status = 'draft' then
        update public.listings set status = 'draft' where parent_id = new.id and status = 'active';
      elsif new.status = 'active' then
        update public.listings set status = 'active' where parent_id = new.id and status = 'draft';
      end if;
    end if;
    if new.timezone <> old.timezone or new.currency <> old.currency then
      perform set_config('pms.confirm_timezone_change', '', true);
      update public.listings set timezone = new.timezone, currency = new.currency where parent_id = new.id;
    end if;
  end if;
  return null;
end;
$$;

create trigger listings_after_change after insert or update on public.listings
  for each row execute function private.listing_after_change();

-- ---------------------------------------------------------------------------
-- RPC: timezone change with confirmation
-- ---------------------------------------------------------------------------

-- Security invoker: RLS (properties.edit, scope) applies to the update.
create or replace function public.change_listing_timezone(p_listing_id uuid, p_timezone text, p_confirm boolean default false)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not p_confirm and public.listing_has_future_bookings(p_listing_id) then
    raise exception 'timezone_change_requires_confirmation: the listing has future bookings' using errcode = 'P0001';
  end if;
  if p_confirm then
    perform set_config('pms.confirm_timezone_change', p_listing_id::text, true);
  end if;
  update public.listings set timezone = p_timezone where id = p_listing_id and type <> 'sub_unit';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform set_config('pms.confirm_timezone_change', '', true);
end;
$$;

revoke execute on function public.listing_activation_problems(uuid) from public, anon;
revoke execute on function public.change_listing_timezone(uuid, text, boolean) from public, anon;
grant execute on function public.listing_activation_problems(uuid) to authenticated, service_role;
grant execute on function public.change_listing_timezone(uuid, text, boolean) to authenticated, service_role;

revoke execute on all functions in schema private from public;
