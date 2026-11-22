-- Step 3 / PRP-12: account-defined custom fields and their per-listing values.
-- Secret values (door codes, Wi-Fi passwords) are encrypted by the app server (AES-256-GCM,
-- X-15) before they reach the database; the database only accepts the ciphertext format, never
-- returns it to clients except through listing_secret_ciphertexts(), and redacts it in the
-- audit log and events.

create type public.custom_field_type as enum ('text', 'number', 'date', 'dropdown', 'secret');

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  -- Message variable name: {{custom.<key>}}. Immutable once created.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  label text not null check (length(btrim(label)) between 1 and 100),
  field_type public.custom_field_type not null,
  options text[] not null default '{}',
  position integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, key),
  unique (id, account_id),
  constraint custom_fields_options check (
    (field_type = 'dropdown' and cardinality(options) between 1 and 100)
    or (field_type <> 'dropdown' and cardinality(options) = 0)
  )
);

create or replace function private.guard_custom_field()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.key <> old.key or new.field_type <> old.field_type or new.account_id <> old.account_id then
    raise exception 'custom_field_immutable: key and type cannot change' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger custom_fields_guard before update on public.custom_fields
  for each row execute function private.guard_custom_field();
create trigger custom_fields_touch before update on public.custom_fields
  for each row execute function private.touch_updated_at();
create trigger audit_custom_fields after insert or update or delete on public.custom_fields
  for each row execute function private.audit_row_change();
create trigger events_custom_fields after insert or update on public.custom_fields
  for each row execute function private.emit_row_event('custom_field');

create table public.listing_custom_values (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  listing_id uuid not null,
  field_id uuid not null,
  value_text text check (value_text is null or length(value_text) <= 2000),
  value_number numeric check (value_number is null or abs(value_number) < 1e12),
  value_date date,
  -- "v1.<iv>.<tag>.<ciphertext>" from src/lib/crypto/secrets.ts — plaintext is rejected.
  value_secret_ciphertext text check (
    value_secret_ciphertext is null
    or (value_secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' and length(value_secret_ciphertext) <= 4000)
  ),
  secret_is_set boolean generated always as (value_secret_ciphertext is not null) stored,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  foreign key (field_id, account_id) references public.custom_fields (id, account_id),
  unique (listing_id, field_id),
  constraint listing_custom_values_one_value check (num_nonnulls(value_text, value_number, value_date, value_secret_ciphertext) = 1)
);

create index listing_custom_values_field_idx on public.listing_custom_values (field_id);

create or replace function private.validate_listing_custom_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field public.custom_fields;
begin
  select * into v_field from public.custom_fields where id = new.field_id;
  if (v_field.field_type in ('text', 'dropdown') and new.value_text is null)
     or (v_field.field_type = 'number' and new.value_number is null)
     or (v_field.field_type = 'date' and new.value_date is null)
     or (v_field.field_type = 'secret' and new.value_secret_ciphertext is null) then
    raise exception 'custom_value_type_mismatch: field % is of type %', v_field.key, v_field.field_type using errcode = '22023';
  end if;
  if v_field.field_type = 'dropdown' and not (new.value_text = any (v_field.options)) then
    raise exception 'custom_value_not_an_option: %', v_field.key using errcode = '22023';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger listing_custom_values_validate before insert or update on public.listing_custom_values
  for each row execute function private.validate_listing_custom_value();
create trigger listing_custom_values_touch before update on public.listing_custom_values
  for each row execute function private.touch_updated_at();
create trigger audit_listing_custom_values after insert or update or delete on public.listing_custom_values
  for each row execute function private.audit_row_change('value_secret_ciphertext');
create trigger events_listing_custom_values after insert or update or delete on public.listing_custom_values
  for each row execute function private.emit_listing_content_event('custom_fields', 'value_secret_ciphertext');

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.custom_fields enable row level security;
alter table public.listing_custom_values enable row level security;
revoke all on public.custom_fields, public.listing_custom_values from anon;
revoke delete, truncate on public.custom_fields from authenticated;
-- Values: read without the ciphertext; write only through the RPCs below.
revoke all on public.listing_custom_values from authenticated;
grant select (id, account_id, listing_id, field_id, value_text, value_number, value_date, secret_is_set, updated_by, created_at, updated_at)
  on public.listing_custom_values to authenticated;

create policy custom_fields_select on public.custom_fields
  for select to authenticated
  using (private.has_permission(account_id, 'properties.view'));
-- Field definitions are account settings: admins (properties.manage).
create policy custom_fields_insert on public.custom_fields
  for insert to authenticated
  with check (private.has_permission(account_id, 'properties.manage'));
create policy custom_fields_update on public.custom_fields
  for update to authenticated
  using (private.has_permission(account_id, 'properties.manage'))
  with check (private.has_permission(account_id, 'properties.manage'));

create policy listing_custom_values_select on public.listing_custom_values
  for select to authenticated
  using (private.has_permission(account_id, 'properties.view')
         and exists (select 1 from public.listings l where l.id = listing_id));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function private.assert_can_on_listing(p_listing_id uuid, p_permission text)
returns public.listings
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
     or not private.can_access_listing(v_listing.account_id, v_listing.id, private.listing_scope_tags(v_listing))
     or not private.has_permission(v_listing.account_id, 'properties.view') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.has_permission(v_listing.account_id, p_permission) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_listing;
end;
$$;

-- Set one value (exactly one of the value arguments, matching the field type).
create or replace function public.set_listing_custom_value(
  p_listing_id uuid,
  p_field_id uuid,
  p_text text default null,
  p_number numeric default null,
  p_date date default null,
  p_secret_ciphertext text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.listings := private.assert_can_on_listing(p_listing_id, 'properties.edit');
begin
  if not exists (
    select 1 from public.custom_fields f
    where f.id = p_field_id and f.account_id = v_listing.account_id and f.archived_at is null
  ) then
    raise exception 'not_found: custom field' using errcode = 'P0002';
  end if;
  insert into public.listing_custom_values
    (account_id, listing_id, field_id, value_text, value_number, value_date, value_secret_ciphertext)
  values (v_listing.account_id, p_listing_id, p_field_id, p_text, p_number, p_date, p_secret_ciphertext)
  on conflict (listing_id, field_id) do update
    set value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_date = excluded.value_date,
        value_secret_ciphertext = excluded.value_secret_ciphertext
    where (public.listing_custom_values.value_text, public.listing_custom_values.value_number,
           public.listing_custom_values.value_date, public.listing_custom_values.value_secret_ciphertext)
          is distinct from (excluded.value_text, excluded.value_number, excluded.value_date, excluded.value_secret_ciphertext);
end;
$$;

create or replace function public.clear_listing_custom_value(p_listing_id uuid, p_field_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.listings := private.assert_can_on_listing(p_listing_id, 'properties.edit');
begin
  delete from public.listing_custom_values v where v.listing_id = v_listing.id and v.field_id = p_field_id;
end;
$$;

-- Ciphertexts of the listing's secret values (and, for a sub-unit, its parent's), for
-- decryption on the app server: editors (reveal in the UI) and the service role (message
-- variables). Never call this from the browser.
create or replace function public.listing_secret_ciphertexts(p_listing_id uuid)
returns table (listing_id uuid, field_id uuid, key text, ciphertext text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_listing public.listings;
begin
  if private.is_client_request() then
    v_listing := private.assert_can_on_listing(p_listing_id, 'properties.edit');
  else
    select * into v_listing from public.listings l where l.id = p_listing_id;
  end if;
  return query
  select v.listing_id, v.field_id, f.key, v.value_secret_ciphertext
  from public.listing_custom_values v
  join public.custom_fields f on f.id = v.field_id
  where v.listing_id in (v_listing.id, v_listing.parent_id)
    and f.field_type = 'secret'
    and f.archived_at is null
    and v.value_secret_ciphertext is not null;
end;
$$;

revoke execute on function public.set_listing_custom_value(uuid, uuid, text, numeric, date, text) from public, anon;
revoke execute on function public.clear_listing_custom_value(uuid, uuid) from public, anon;
revoke execute on function public.listing_secret_ciphertexts(uuid) from public, anon;
grant execute on function public.set_listing_custom_value(uuid, uuid, text, numeric, date, text) to authenticated, service_role;
grant execute on function public.clear_listing_custom_value(uuid, uuid) to authenticated, service_role;
grant execute on function public.listing_secret_ciphertexts(uuid) to authenticated, service_role;

revoke execute on all functions in schema private from public;
