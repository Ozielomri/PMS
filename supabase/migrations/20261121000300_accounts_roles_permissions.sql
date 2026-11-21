-- Step 1 / X-01, X-02: accounts, profiles, memberships, roles, permissions, listing scope,
-- invitations. Admin permissions require a TOTP-verified session (JWT claim aal = 'aal2').

create type public.account_role as enum ('admin', 'manager', 'front_office', 'supervisor', 'cleaner');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  timezone text not null default 'America/New_York',
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text check (full_name is null or length(full_name) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  -- profiles (not auth.users) so PostgREST can embed the member's name and email.
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  role public.account_role not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  listing_scope text not null default 'all' check (listing_scope in ('all', 'restricted')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, user_id),
  unique (id, account_id),
  constraint admins_see_all_listings check (role <> 'admin' or listing_scope = 'all')
);

create index memberships_user_idx on public.memberships (user_id) where status = 'active';

-- X-01 listing scope: a restricted member sees only listings matching one of these rows.
create table public.membership_listing_scopes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  membership_id uuid not null,
  kind text not null check (kind in ('tag', 'listing')),
  value text not null check (length(value) between 1 and 200),
  created_at timestamptz not null default now(),
  foreign key (membership_id, account_id) references public.memberships (id, account_id) on delete cascade,
  unique (membership_id, kind, value)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.account_role not null,
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index invitations_one_pending_per_email
  on public.invitations (account_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- Reference data: which role has which permission. Kept identical to
-- src/lib/auth/permissions.ts (enforced by tests/db/permissions.test.ts).
create table public.role_permissions (
  role public.account_role not null,
  permission text not null check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  primary key (role, permission)
);

insert into public.role_permissions (role, permission)
select 'admin'::public.account_role, p
from unnest(array[
  'account.view', 'account.manage_settings', 'account.manage_users', 'audit.view', 'events.view', 'webhooks.manage',
  'properties.view', 'properties.view_assigned', 'properties.edit', 'properties.manage',
  'calendar.view', 'calendar.block', 'calendar.edit', 'calendar.manage',
  'reservations.view', 'reservations.view_money', 'reservations.view_next_guest', 'reservations.create',
  'reservations.edit', 'reservations.cancel', 'reservations.manage',
  'inbox.view', 'inbox.reply', 'inbox.manage',
  'automations.view', 'automations.edit', 'automations.manage',
  'tasks.view', 'tasks.view_own', 'tasks.update_own', 'tasks.create', 'tasks.assign', 'tasks.edit', 'tasks.manage'
]) as p
union all
select 'manager', p
from unnest(array[
  'account.view', 'events.view',
  'properties.view', 'properties.view_assigned', 'properties.edit',
  'calendar.view', 'calendar.block', 'calendar.edit',
  'reservations.view', 'reservations.view_money', 'reservations.view_next_guest', 'reservations.create',
  'reservations.edit', 'reservations.cancel', 'reservations.manage',
  'inbox.view', 'inbox.reply', 'inbox.manage',
  'automations.view', 'automations.edit',
  'tasks.view', 'tasks.view_own', 'tasks.update_own', 'tasks.create', 'tasks.assign', 'tasks.edit', 'tasks.manage'
]) as p
union all
select 'front_office', p
from unnest(array[
  'account.view',
  'properties.view', 'properties.view_assigned',
  'calendar.view', 'calendar.block',
  'reservations.view', 'reservations.view_money', 'reservations.view_next_guest', 'reservations.create',
  'reservations.edit',
  'inbox.view', 'inbox.reply', 'inbox.manage',
  'automations.view',
  'tasks.view', 'tasks.view_own', 'tasks.create', 'tasks.assign'
]) as p
union all
select 'supervisor', p
from unnest(array[
  'account.view',
  'properties.view', 'properties.view_assigned',
  'calendar.view',
  'reservations.view', 'reservations.view_next_guest',
  'inbox.view',
  'tasks.view', 'tasks.view_own', 'tasks.update_own', 'tasks.create', 'tasks.assign', 'tasks.edit', 'tasks.manage'
]) as p
union all
select 'cleaner', p
from unnest(array[
  'account.view',
  'properties.view_assigned',
  'reservations.view_next_guest',
  'tasks.view_own', 'tasks.update_own'
]) as p;

-- ---------------------------------------------------------------------------
-- Authorization helpers (used by RLS policies of every module)
-- ---------------------------------------------------------------------------

create or replace function private.current_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1')
$$;

-- Active member of the account, regardless of role or MFA level.
create or replace function private.is_member(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.account_id = p_account_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  )
$$;

-- Role of the current user in the account (null if not an active member).
create or replace function private.member_role(p_account_id uuid)
returns public.account_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.memberships m
  where m.account_id = p_account_id
    and m.user_id = (select auth.uid())
    and m.status = 'active'
$$;

-- X-01 + X-02: does the current user hold this permission in this account?
-- An admin whose session is not TOTP-verified (aal2) holds no permissions at all.
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
      and (m.role <> 'admin' or private.current_aal() = 'aal2')
  )
$$;

-- X-01 listing scope. Listing tables (step 3) call this in their RLS policies, passing the
-- listing's id and its tags (for sub-units: the parent's tags too).
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
      and (m.role <> 'admin' or private.current_aal() = 'aal2')
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

-- Users who share at least one account with the current user (for showing names).
create or replace function private.shares_account_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = (select auth.uid())
      or exists (
        select 1
        from public.memberships mine
        join public.memberships theirs on theirs.account_id = mine.account_id
        where mine.user_id = (select auth.uid())
          and mine.status = 'active'
          and theirs.user_id = p_user_id
      )
$$;

revoke execute on all functions in schema private from public;

-- Helpers called by RLS policies (evaluated as the requesting role).
grant execute on function
  private.current_aal(),
  private.is_member(uuid),
  private.member_role(uuid),
  private.has_permission(uuid, text),
  private.can_access_listing(uuid, uuid, text[]),
  private.shares_account_with(uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger accounts_touch before update on public.accounts
  for each row execute function private.touch_updated_at();
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger memberships_touch before update on public.memberships
  for each row execute function private.touch_updated_at();
create trigger invitations_touch before update on public.invitations
  for each row execute function private.touch_updated_at();

create or replace function private.validate_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger accounts_validate before insert or update of timezone on public.accounts
  for each row execute function private.validate_account();

-- An account must always keep at least one active admin.
create or replace function private.guard_last_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'admin' and old.status = 'active'
     and (new.role <> 'admin' or new.status <> 'active')
     and not exists (
       select 1 from public.memberships m
       where m.account_id = old.account_id
         and m.id <> old.id
         and m.role = 'admin'
         and m.status = 'active'
     ) then
    raise exception 'last_admin: an account must keep at least one active admin' using errcode = 'P0001';
  end if;
  if new.account_id <> old.account_id or new.user_id <> old.user_id then
    raise exception 'membership account and user cannot change' using errcode = '42501';
  end if;
  if new.role = 'admin' then
    new.listing_scope := 'all'; -- admins always see every listing
  end if;
  return new;
end;
$$;

create trigger memberships_guard_last_admin before update on public.memberships
  for each row execute function private.guard_last_admin();

-- Keep profiles in sync with auth.users.
create or replace function private.sync_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, coalesce(new.email, ''), nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (user_id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name);
  return new;
end;
$$;

create trigger on_auth_user_changed
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function private.sync_profile_from_auth_user();

-- ---------------------------------------------------------------------------
-- Audit (X-03) and domain events (X-04)
-- ---------------------------------------------------------------------------

create trigger audit_accounts after insert or update or delete on public.accounts
  for each row execute function private.audit_row_change();
create trigger audit_memberships after insert or update or delete on public.memberships
  for each row execute function private.audit_row_change();
create trigger audit_membership_listing_scopes after insert or update or delete on public.membership_listing_scopes
  for each row execute function private.audit_row_change();
create trigger audit_invitations after insert or update or delete on public.invitations
  for each row execute function private.audit_row_change('token_hash');

-- Generic "<entity>.created / <entity>.updated" events. Argument 1 = entity name; further
-- arguments = columns left out of the payload.
create or replace function private.emit_row_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_hidden text[] := coalesce(tg_argv[1:], '{}');
  v_new jsonb := to_jsonb(new) - v_hidden;
  v_old jsonb;
  v_changes jsonb;
  v_account uuid := coalesce(v_new ->> 'account_id', case when tg_table_name = 'accounts' then v_new ->> 'id' end)::uuid;
begin
  if tg_op = 'INSERT' then
    perform private.emit_event(v_account, v_entity || '.created', v_entity, v_new ->> 'id',
                               jsonb_build_object('record', v_new));
  else
    v_old := to_jsonb(old) - v_hidden;
    v_changes := private.row_diff(v_old, v_new);
    if v_changes <> '{}'::jsonb then
      perform private.emit_event(v_account, v_entity || '.updated', v_entity, v_new ->> 'id',
                                 jsonb_build_object('record', v_new, 'changes', v_changes));
    end if;
  end if;
  return null;
end;
$$;

create trigger events_accounts after insert or update on public.accounts
  for each row execute function private.emit_row_event('account');

create trigger events_invitations after insert or update on public.invitations
  for each row execute function private.emit_row_event('invitation', 'token_hash');

-- Memberships: created / updated, plus membership.removed when status becomes 'removed'.
create or replace function private.emit_membership_event()
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
    perform private.emit_event(new.account_id, 'membership.created', 'membership', new.id::text,
                               jsonb_build_object('record', v_new));
    return null;
  end if;
  v_changes := private.row_diff(to_jsonb(old), v_new);
  if v_changes = '{}'::jsonb then
    return null;
  end if;
  perform private.emit_event(
    new.account_id,
    case when new.status = 'removed' and old.status <> 'removed' then 'membership.removed' else 'membership.updated' end,
    'membership', new.id::text,
    jsonb_build_object('record', v_new, 'changes', v_changes)
  );
  return null;
end;
$$;

create trigger events_memberships after insert or update on public.memberships
  for each row execute function private.emit_membership_event();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.accounts enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_listing_scopes enable row level security;
alter table public.invitations enable row level security;
alter table public.role_permissions enable row level security;

-- Writes go through the RPCs below or through narrow column grants.
revoke insert, update, delete, truncate on
  public.accounts, public.profiles, public.memberships, public.membership_listing_scopes,
  public.invitations, public.role_permissions
from anon, authenticated;
revoke all on
  public.accounts, public.profiles, public.memberships, public.membership_listing_scopes,
  public.invitations, public.role_permissions
from anon;

grant update (name, timezone) on public.accounts to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant update (role, status, listing_scope) on public.memberships to authenticated;
grant update (revoked_at) on public.invitations to authenticated;

create policy accounts_select on public.accounts
  for select to authenticated
  using (private.is_member(id));

create policy accounts_update on public.accounts
  for update to authenticated
  using (private.has_permission(id, 'account.manage_settings'))
  with check (private.has_permission(id, 'account.manage_settings'));

create policy profiles_select on public.profiles
  for select to authenticated
  using (private.shares_account_with(user_id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Everyone sees their own memberships (so the app can route an aal1 admin to MFA);
-- account members with account.view see the whole team.
create policy memberships_select on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(account_id, 'account.view'));

create policy memberships_update on public.memberships
  for update to authenticated
  using (private.has_permission(account_id, 'account.manage_users'))
  with check (private.has_permission(account_id, 'account.manage_users'));

create policy listing_scopes_select on public.membership_listing_scopes
  for select to authenticated
  using (
    private.has_permission(account_id, 'account.manage_users')
    or exists (select 1 from public.memberships m where m.id = membership_id and m.user_id = (select auth.uid()))
  );

create policy invitations_select on public.invitations
  for select to authenticated
  using (private.has_permission(account_id, 'account.manage_users'));

create policy invitations_revoke on public.invitations
  for update to authenticated
  using (private.has_permission(account_id, 'account.manage_users') and accepted_at is null)
  with check (private.has_permission(account_id, 'account.manage_users'));

create policy role_permissions_read on public.role_permissions
  for select to authenticated
  using (true);

create policy audit_log_select on public.audit_log
  for select to authenticated
  using (private.has_permission(account_id, 'audit.view'));

create policy domain_events_select on public.domain_events
  for select to authenticated
  using (private.has_permission(account_id, 'events.view'));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create an account; the caller becomes its first admin.
create or replace function public.create_account(p_name text, p_timezone text default 'America/New_York')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_account_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  insert into public.accounts (name, timezone, created_by)
  values (btrim(p_name), coalesce(nullif(p_timezone, ''), 'America/New_York'), v_uid)
  returning id into v_account_id;

  insert into public.memberships (account_id, user_id, role, status)
  values (v_account_id, v_uid, 'admin', 'active');
  return v_account_id;
end;
$$;

-- Invite someone by email. Returns the raw token once; only its SHA-256 is stored.
create or replace function public.create_invitation(
  p_account_id uuid,
  p_email text,
  p_role public.account_role
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email text := lower(btrim(p_email));
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
  v_expires timestamptz;
begin
  if not private.has_permission(p_account_id, 'account.manage_users') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.memberships m
    join public.profiles p on p.user_id = m.user_id
    where m.account_id = p_account_id and m.status = 'active' and lower(p.email) = v_email
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;

  update public.invitations i
  set revoked_at = now()
  where i.account_id = p_account_id and lower(i.email) = v_email
    and i.accepted_at is null and i.revoked_at is null;

  insert into public.invitations (account_id, email, role, token_hash, invited_by)
  values (p_account_id, v_email, p_role,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning id, invitations.expires_at into v_id, v_expires;

  return query select v_id, v_token, v_expires;
end;
$$;

-- Public preview of an invitation (for the /invite/[token] page).
create or replace function public.get_invitation(p_token text)
returns table (account_name text, email text, role public.account_role, status text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.name, i.email, i.role,
         case
           when i.accepted_at is not null then 'accepted'
           when i.revoked_at is not null then 'revoked'
           when i.expires_at < now() then 'expired'
           else 'pending'
         end,
         i.expires_at
  from public.invitations i
  join public.accounts a on a.id = i.account_id
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Accept an invitation as the signed-in user; the email must match. Returns the membership id.
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv public.invitations;
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into v_inv from public.invitations i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;

  if not found or v_inv.revoked_at is not null or v_inv.accepted_at is not null then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  end if;
  if v_email is distinct from lower(v_inv.email) then
    raise exception 'invitation_email_mismatch' using errcode = 'P0001';
  end if;

  insert into public.memberships (account_id, user_id, role, status, invited_by)
  values (v_inv.account_id, v_uid, v_inv.role, 'active', v_inv.invited_by)
  on conflict (account_id, user_id) do update
    set role = excluded.role,
        status = 'active',
        listing_scope = case when excluded.role = 'admin' then 'all' else public.memberships.listing_scope end
  returning id into v_membership_id;

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id;

  return v_membership_id;
end;
$$;

-- Replace a member's listing scope atomically.
create or replace function public.set_membership_listing_scope(
  p_membership_id uuid,
  p_scope text,
  p_tags text[] default '{}',
  p_listing_ids uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.memberships;
begin
  select * into v_m from public.memberships where id = p_membership_id for update;
  if not found or not private.has_permission(v_m.account_id, 'account.manage_users') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_scope not in ('all', 'restricted') then
    raise exception 'invalid scope: %', p_scope using errcode = '22023';
  end if;
  if p_scope = 'restricted' and v_m.role = 'admin' then
    raise exception 'admins_see_all_listings: admins always see every listing' using errcode = '22023';
  end if;

  update public.memberships set listing_scope = p_scope where id = v_m.id;
  delete from public.membership_listing_scopes where membership_id = v_m.id;

  if p_scope = 'restricted' then
    insert into public.membership_listing_scopes (account_id, membership_id, kind, value)
    select v_m.account_id, v_m.id, 'tag', t
    from (select distinct btrim(t) as t from unnest(coalesce(p_tags, '{}')) t) tags
    where t <> ''
    union all
    select v_m.account_id, v_m.id, 'listing', l::text
    from (select distinct l from unnest(coalesce(p_listing_ids, '{}')) l) ids;
  end if;
end;
$$;

revoke execute on function public.create_account(text, text) from public, anon;
revoke execute on function public.create_invitation(uuid, text, public.account_role) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.set_membership_listing_scope(uuid, text, text[], uuid[]) from public, anon;
grant execute on function public.create_account(text, text) to authenticated;
grant execute on function public.create_invitation(uuid, text, public.account_role) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.set_membership_listing_scope(uuid, text, text[], uuid[]) to authenticated;
grant execute on function public.get_invitation(text) to anon, authenticated;

revoke execute on all functions in schema private from public;
