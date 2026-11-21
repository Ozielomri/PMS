-- Step 1 / X-03: private helper schema, request-context helpers and the audit log.
--
-- Conventions used by every later migration:
--   * Helper functions live in schema `private`, which PostgREST does not expose.
--   * Security-definer functions always pin `search_path = ''` and schema-qualify everything.
--   * Timestamps are timestamptz (UTC); dates are local dates in the listing timezone.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Postgres grants EXECUTE on new functions to PUBLIC, and per-schema default privileges cannot
-- take that away. Every migration that adds functions to `private` therefore ends with
--   revoke execute on all functions in schema private from public;
-- and grants back only the helpers that RLS policies call (see 000300).

-- ---------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------

-- PostgREST exposes the HTTP request headers as JSON in `request.headers`.
create or replace function private.request_headers()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');
begin
  if v_raw is null then
    return '{}'::jsonb;
  end if;
  return v_raw::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

-- Role of the current request: 'authenticated', 'anon', 'service_role', or null for a direct
-- database connection (migrations, SQL editor, tests running as postgres).
create or replace function private.request_role()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  ), '')
$$;

-- Who is making this change. Users are identified by their JWT. Non-user actors (automations,
-- channel sync, the public API, system jobs) are only trusted from the service role or a direct
-- database connection, either through `pms.actor_*` settings or `x-pms-actor-*` headers.
create or replace function private.current_actor(
  out actor_type text,
  out actor_id text,
  out user_id uuid
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := private.request_role();
  v_headers jsonb;
begin
  if v_uid is not null then
    actor_type := 'user';
    actor_id := v_uid::text;
    user_id := v_uid;
    return;
  end if;

  if v_role is null or v_role = 'service_role' then
    actor_type := nullif(current_setting('pms.actor_type', true), '');
    actor_id := nullif(current_setting('pms.actor_id', true), '');
    if actor_type is null then
      v_headers := private.request_headers();
      actor_type := nullif(v_headers ->> 'x-pms-actor-type', '');
      actor_id := nullif(v_headers ->> 'x-pms-actor-id', '');
    end if;
  end if;

  if actor_type is null or actor_type not in ('automation', 'channel', 'api', 'system') then
    actor_type := 'system';
    actor_id := coalesce(actor_id, v_role);
  end if;
end;
$$;

-- Client IP: our server-side Supabase client forwards the browser's IP as `x-pms-client-ip`;
-- otherwise the first `x-forwarded-for` hop. Workers can set `pms.client_ip`.
create or replace function private.current_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers jsonb := private.request_headers();
  v_ip text;
begin
  v_ip := coalesce(
    nullif(current_setting('pms.client_ip', true), ''),
    nullif(v_headers ->> 'x-pms-client-ip', ''),
    nullif(split_part(v_headers ->> 'x-forwarded-for', ',', 1), ''),
    nullif(v_headers ->> 'x-real-ip', '')
  );
  if v_ip is null then
    return null;
  end if;
  return trim(v_ip)::inet;
exception when others then
  return null;
end;
$$;

create or replace function private.current_request_id()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('pms.request_id', true), ''),
    nullif(private.request_headers() ->> 'x-request-id', ''),
    nullif(private.request_headers() ->> 'x-vercel-id', '')
  )
$$;

-- Replace the values of the given keys with "[redacted]" (null stays null, so the log still
-- shows whether a secret is set).
create or replace function private.redact(p_row jsonb, p_keys text[])
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_out jsonb := p_row;
begin
  if p_row is null or p_keys is null then
    return p_row;
  end if;
  foreach v_key in array p_keys loop
    if v_out ? v_key and jsonb_typeof(v_out -> v_key) <> 'null' then
      v_out := jsonb_set(v_out, array[v_key], '"[redacted]"'::jsonb);
    end if;
  end loop;
  return v_out;
end;
$$;

-- Field-level diff between two row images: {"field": {"old": ..., "new": ...}}.
-- Keys in p_ignore are skipped (e.g. updated_at).
create or replace function private.row_diff(p_old jsonb, p_new jsonb, p_ignore text[] default array['updated_at'])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(
    k,
    case
      when p_old is null then jsonb_build_object('new', p_new -> k)
      when p_new is null then jsonb_build_object('old', p_old -> k)
      else jsonb_build_object('old', p_old -> k, 'new', p_new -> k)
    end
  ), '{}'::jsonb)
  from (
    select jsonb_object_keys(coalesce(p_new, '{}'::jsonb)) as k
    union
    select jsonb_object_keys(coalesce(p_old, '{}'::jsonb))
  ) keys
  where not (k = any (coalesce(p_ignore, '{}')))
    and (p_old -> k) is distinct from (p_new -> k)
    -- on insert/delete, leave out columns that are simply null
    and not (p_old is null and jsonb_typeof(p_new -> k) = 'null')
    and not (p_new is null and jsonb_typeof(p_old -> k) = 'null')
$$;

-- ---------------------------------------------------------------------------
-- Audit log (X-03)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  account_id uuid,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'automation', 'channel', 'api', 'system')),
  actor_id text,
  actor_user_id uuid,
  entity_type text not null,
  entity_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  diff jsonb not null,
  ip inet,
  request_id text,
  txid bigint not null default txid_current()
);

comment on table public.audit_log is
  'X-03: append-only audit trail of every create/update/delete. Retained 2 years (private.purge_audit_log).';

create index audit_log_account_time_idx on public.audit_log (account_id, occurred_at desc, id desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, occurred_at desc);
create index audit_log_actor_user_idx on public.audit_log (actor_user_id, occurred_at desc)
  where actor_user_id is not null;

alter table public.audit_log enable row level security;
revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;

-- Generic row trigger. Trigger arguments = column names to redact (secrets).
-- account_id is read from the row's account_id column (or id for the accounts table).
create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redact text[] := coalesce(tg_argv::text[], '{}');
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_diff jsonb;
  v_actor record;
  v_account_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := private.redact(to_jsonb(old), v_redact);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := private.redact(to_jsonb(new), v_redact);
  end if;

  -- Redacted columns that changed must still show up in the diff, so compare raw values for them.
  if tg_op = 'UPDATE' then
    v_diff := private.row_diff(v_old, v_new);
    v_diff := v_diff || coalesce((
      select jsonb_object_agg(k, jsonb_build_object('old', '"[redacted]"'::jsonb, 'new', '"[redacted]"'::jsonb))
      from unnest(v_redact) k
      where (to_jsonb(old) -> k) is distinct from (to_jsonb(new) -> k)
        and not (v_diff ? k)
    ), '{}'::jsonb);
    if v_diff = '{}'::jsonb then
      return null; -- nothing but ignored columns changed
    end if;
  else
    v_diff := private.row_diff(v_old, v_new);
  end if;

  v_row := coalesce(v_new, v_old);
  v_account_id := coalesce(
    v_row ->> 'account_id',
    case when tg_table_name = 'accounts' then v_row ->> 'id' end
  )::uuid;

  select * into v_actor from private.current_actor();

  insert into public.audit_log (
    account_id, actor_type, actor_id, actor_user_id, entity_type, entity_id, action, diff, ip, request_id
  ) values (
    v_account_id,
    v_actor.actor_type,
    v_actor.actor_id,
    v_actor.user_id,
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id', '?'),
    lower(tg_op),
    v_diff,
    private.current_ip(),
    private.current_request_id()
  );
  return null;
end;
$$;

-- Append-only: no updates, no deletes except through private.purge_audit_log().
create or replace function private.audit_log_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('pms.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function private.audit_log_guard();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.audit_log_guard();

-- Retention: delete entries older than the retention period (never less than 2 years).
create or replace function private.purge_audit_log(p_retention interval default interval '2 years')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  if p_retention < interval '2 years' then
    raise exception 'audit retention must be at least 2 years' using errcode = '22023';
  end if;
  perform set_config('pms.audit_purge', 'on', true);
  delete from public.audit_log where occurred_at < now() - p_retention;
  get diagnostics v_count = row_count;
  perform set_config('pms.audit_purge', 'off', true);
  return v_count;
end;
$$;

revoke execute on all functions in schema private from public;
