-- X-02 switch: whether admins must use their authenticator (TOTP, aal2) before they hold any
-- permission. Off for the technical trial (decided 23 Nov 2026); turn it back on with
--   update private.app_settings set mfa_required = true;
-- The app reads the same switch through public.mfa_required(), so the screens and the database
-- always agree. Turning it on again needs no code change.

create table private.app_settings (
  id boolean primary key default true check (id),
  mfa_required boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table private.app_settings is 'Single-row platform switches (X-02 mfa_required).';

insert into private.app_settings (id, mfa_required) values (true, false);

revoke all on private.app_settings from public, anon, authenticated;

-- A request may make the check stricter (tests set pms.mfa_required = on), never looser.
create or replace function private.mfa_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.mfa_required from private.app_settings s where s.id), true)
      or coalesce(current_setting('pms.mfa_required', true) = 'on', false)
$$;

create or replace function public.mfa_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.mfa_required()
$$;

revoke execute on function public.mfa_required() from public, anon;
grant execute on function public.mfa_required() to authenticated, service_role;

-- Same definitions as in 20261121000300, with the admin MFA gate behind the switch.
create or replace function private.has_permission(p_account_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.account_id = p_account_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.role <> 'admin' or private.current_aal() = 'aal2' or not private.mfa_required())
  )
$$;

create or replace function private.can_access_listing(
  p_account_id uuid,
  p_listing_id uuid,
  p_listing_tags text[] default '{}'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.account_id = p_account_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.role <> 'admin' or private.current_aal() = 'aal2' or not private.mfa_required())
      and (
        m.listing_scope = 'all'
        or exists (
          select 1 from public.membership_listing_scopes s
          where s.membership_id = m.id
            and (
              (s.kind = 'listing' and s.value = p_listing_id::text)
              or (s.kind = 'tag' and lower(s.value) in (select lower(t) from unnest(coalesce(p_listing_tags, '{}')) t))
            )
        )
      )
  )
$$;

revoke execute on all functions in schema private from public;
