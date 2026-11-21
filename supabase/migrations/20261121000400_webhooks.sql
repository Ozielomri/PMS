-- Step 1 / X-04 (part 2): outbound webhooks with HMAC signatures, retries for 24 hours and a
-- delivery log. The dispatcher (src/lib/webhooks/dispatcher.ts) signs and sends; this schema
-- owns fan-out, claiming, scheduling state and the log.

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  url text not null check (url ~* '^https?://[^\s]+$' and length(url) <= 2000),
  description text check (description is null or length(description) <= 500),
  event_types text[] not null default '{*}' check (cardinality(event_types) between 1 and 100),
  -- AES-256-GCM ciphertext of the signing secret (X-15 field-level encryption); never returned to clients.
  secret_ciphertext text not null,
  secret_last4 text not null,
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, account_id)
);

create index webhook_endpoints_account_idx on public.webhook_endpoints (account_id) where active;

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  endpoint_id uuid not null,
  event_id uuid not null references public.domain_events (id),
  event_type text not null,
  status text not null default 'pending' check (status in ('pending', 'delivering', 'succeeded', 'failed')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  last_status_code integer,
  last_error text,
  redelivery_of uuid references public.webhook_deliveries (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (endpoint_id, account_id) references public.webhook_endpoints (id, account_id)
);

create unique index webhook_deliveries_once_per_event
  on public.webhook_deliveries (endpoint_id, event_id)
  where redelivery_of is null;
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'delivering');
create index webhook_deliveries_account_idx on public.webhook_deliveries (account_id, created_at desc);
create index webhook_deliveries_endpoint_idx on public.webhook_deliveries (endpoint_id, created_at desc);

create table public.webhook_delivery_attempts (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.webhook_deliveries (id),
  account_id uuid not null,
  attempt_number integer not null,
  attempted_at timestamptz not null default now(),
  duration_ms integer,
  status_code integer,
  error text,
  response_body text
);

create index webhook_delivery_attempts_delivery_idx on public.webhook_delivery_attempts (delivery_id, attempt_number);

create trigger webhook_endpoints_touch before update on public.webhook_endpoints
  for each row execute function private.touch_updated_at();

create trigger audit_webhook_endpoints after insert or update or delete on public.webhook_endpoints
  for each row execute function private.audit_row_change('secret_ciphertext');

create trigger events_webhook_endpoints after insert or update on public.webhook_endpoints
  for each row execute function private.emit_row_event('webhook_endpoint', 'secret_ciphertext');

-- Fan-out: one delivery per (active endpoint whose filter matches, event).
create or replace function private.fanout_events_to_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.webhook_deliveries (account_id, endpoint_id, event_id, event_type)
  select e.account_id, w.id, e.id, e.type
  from new_events e
  join public.webhook_endpoints w
    on w.account_id = e.account_id
   and w.active
   and private.event_type_matches(w.event_types, e.type)
  on conflict do nothing;
  return null;
end;
$$;

create trigger domain_events_fanout_webhooks
  after insert on public.domain_events
  referencing new table as new_events
  for each statement execute function private.fanout_events_to_webhooks();

-- ---------------------------------------------------------------------------
-- RLS: only users with webhooks.manage see endpoints and the delivery log.
-- ---------------------------------------------------------------------------

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.webhook_delivery_attempts enable row level security;

revoke all on public.webhook_endpoints, public.webhook_deliveries, public.webhook_delivery_attempts from anon;
revoke all on public.webhook_endpoints, public.webhook_deliveries, public.webhook_delivery_attempts from authenticated;

grant select (id, account_id, url, description, event_types, secret_last4, active, created_by, created_at, updated_at)
  on public.webhook_endpoints to authenticated;
grant insert (id, account_id, url, description, event_types, secret_ciphertext, secret_last4, active)
  on public.webhook_endpoints to authenticated;
grant update (url, description, event_types, secret_ciphertext, secret_last4, active)
  on public.webhook_endpoints to authenticated;
grant select on public.webhook_deliveries, public.webhook_delivery_attempts to authenticated;

create policy webhook_endpoints_select on public.webhook_endpoints
  for select to authenticated
  using (private.has_permission(account_id, 'webhooks.manage'));
create policy webhook_endpoints_insert on public.webhook_endpoints
  for insert to authenticated
  with check (private.has_permission(account_id, 'webhooks.manage'));
create policy webhook_endpoints_update on public.webhook_endpoints
  for update to authenticated
  using (private.has_permission(account_id, 'webhooks.manage'))
  with check (private.has_permission(account_id, 'webhooks.manage'));

create policy webhook_deliveries_select on public.webhook_deliveries
  for select to authenticated
  using (private.has_permission(account_id, 'webhooks.manage'));
create policy webhook_delivery_attempts_select on public.webhook_delivery_attempts
  for select to authenticated
  using (private.has_permission(account_id, 'webhooks.manage'));

-- ---------------------------------------------------------------------------
-- Worker API (service role only)
-- ---------------------------------------------------------------------------

-- Claims due deliveries. Deliveries past their 24-hour window, or whose endpoint was
-- deactivated, are closed as failed first.
create or replace function public.claim_webhook_deliveries(
  p_limit integer default 50,
  p_lease_seconds integer default 60
)
returns table (
  delivery_id uuid,
  account_id uuid,
  attempt_number integer,
  endpoint_id uuid,
  url text,
  secret_ciphertext text,
  event jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.webhook_deliveries d
  set status = 'failed',
      completed_at = now(),
      locked_until = null,
      last_error = case when d.expires_at <= now() then 'expired: no successful delivery within 24 hours'
                        else 'endpoint disabled' end
  from public.webhook_endpoints w
  where w.id = d.endpoint_id
    and d.status in ('pending', 'delivering')
    and (d.locked_until is null or d.locked_until < now())
    and (d.expires_at <= now() or not w.active);

  return query
  with due as (
    select d.id
    from public.webhook_deliveries d
    where d.status in ('pending', 'delivering')
      and d.next_attempt_at <= now()
      and (d.locked_until is null or d.locked_until < now())
    order by d.next_attempt_at, d.id
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  claimed as (
    update public.webhook_deliveries d
    set status = 'delivering',
        attempt_count = d.attempt_count + 1,
        locked_until = now() + make_interval(secs => p_lease_seconds)
    from due
    where d.id = due.id
    returning d.id, d.account_id, d.attempt_count, d.endpoint_id, d.event_id
  )
  select c.id, c.account_id, c.attempt_count, c.endpoint_id, w.url, w.secret_ciphertext, private.event_envelope(e)
  from claimed c
  join public.webhook_endpoints w on w.id = c.endpoint_id
  join public.domain_events e on e.id = c.event_id
  order by e.seq;
end;
$$;

-- Records one attempt. On failure, p_retry_at schedules the next try; null (or a time past the
-- delivery's 24-hour window) closes it as failed.
create or replace function public.record_webhook_attempt(
  p_delivery_id uuid,
  p_success boolean,
  p_status_code integer default null,
  p_error text default null,
  p_duration_ms integer default null,
  p_response_body text default null,
  p_retry_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.webhook_deliveries;
  v_status text;
begin
  select * into v_d from public.webhook_deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'webhook delivery % not found', p_delivery_id using errcode = 'P0002';
  end if;

  insert into public.webhook_delivery_attempts (
    delivery_id, account_id, attempt_number, duration_ms, status_code, error, response_body
  ) values (
    v_d.id, v_d.account_id, v_d.attempt_count, p_duration_ms, p_status_code,
    left(p_error, 2000), left(p_response_body, 2048)
  );

  v_status := case
    when p_success then 'succeeded'
    when p_retry_at is null or p_retry_at > v_d.expires_at then 'failed'
    else 'pending'
  end;

  update public.webhook_deliveries
  set status = v_status,
      last_status_code = p_status_code,
      last_error = case when p_success then null else left(p_error, 2000) end,
      next_attempt_at = case when v_status = 'pending' then p_retry_at else next_attempt_at end,
      locked_until = null,
      completed_at = case when v_status in ('succeeded', 'failed') then now() end
  where id = v_d.id;

  return v_status;
end;
$$;

revoke execute on function public.claim_webhook_deliveries(integer, integer) from public, anon, authenticated;
revoke execute on function public.record_webhook_attempt(uuid, boolean, integer, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_webhook_deliveries(integer, integer) to service_role;
grant execute on function public.record_webhook_attempt(uuid, boolean, integer, text, integer, text, timestamptz) to service_role;

-- Manual redelivery from the delivery log (new 24-hour window).
create or replace function public.redeliver_webhook(p_delivery_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.webhook_deliveries;
  v_id uuid;
begin
  select * into v_d from public.webhook_deliveries where id = p_delivery_id;
  if not found or not private.has_permission(v_d.account_id, 'webhooks.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.webhook_deliveries (account_id, endpoint_id, event_id, event_type, redelivery_of)
  values (v_d.account_id, v_d.endpoint_id, v_d.event_id, v_d.event_type, coalesce(v_d.redelivery_of, v_d.id))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.redeliver_webhook(uuid) from public, anon;
grant execute on function public.redeliver_webhook(uuid) to authenticated;

revoke execute on all functions in schema private from public;
