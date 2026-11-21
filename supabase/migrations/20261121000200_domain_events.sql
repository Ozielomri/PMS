-- Step 1 / X-04 (part 1): domain events outbox and the internal event bus.
--
-- Every state change calls private.emit_event() inside the same transaction as the change, so
-- an event exists if and only if the change committed. A statement-level trigger fans each new
-- event out to:
--   * internal consumers (event_queue)          -- automations, notifications, ...
--   * outbound webhook endpoints (see 000400)   -- webhook_deliveries
-- Workers claim work items with FOR UPDATE SKIP LOCKED and a lease, so they can run in
-- parallel and crash safely; handlers must be idempotent (at-least-once delivery).

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  account_id uuid not null,
  type text not null check (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  actor_type text not null,
  actor_id text,
  occurred_at timestamptz not null default now(),
  txid bigint not null default txid_current()
);

comment on table public.domain_events is
  'X-04: transactional outbox of domain events. Append-only. txid groups events of one transaction.';

create index domain_events_account_seq_idx on public.domain_events (account_id, seq desc);
create index domain_events_entity_idx on public.domain_events (entity_type, entity_id, seq desc);
create index domain_events_type_idx on public.domain_events (account_id, type, seq desc);

alter table public.domain_events enable row level security;
revoke insert, update, delete, truncate on public.domain_events from anon, authenticated;

create or replace function private.domain_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'domain_events is append-only' using errcode = '42501';
end;
$$;

create trigger domain_events_append_only
  before update or delete on public.domain_events
  for each row execute function private.domain_events_guard();

-- Public JSON shape of an event (used by webhooks, the bus and Realtime consumers).
create or replace function private.event_envelope(e public.domain_events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id,
    'type', e.type,
    'account_id', e.account_id,
    'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'sequence', e.seq,
    'transaction_id', e.txid::text,
    'entity', jsonb_build_object('type', e.entity_type, 'id', e.entity_id),
    'actor', jsonb_build_object('type', e.actor_type, 'id', e.actor_id),
    'data', e.payload
  )
$$;

-- Emit a domain event in the current transaction. Only callable from other SQL (triggers,
-- security-definer RPCs) — never directly by clients.
create or replace function private.emit_event(
  p_account_id uuid,
  p_type text,
  p_entity_type text,
  p_entity_id text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_id uuid;
begin
  if p_account_id is null then
    raise exception 'emit_event: account_id is required' using errcode = '23502';
  end if;
  select * into v_actor from private.current_actor();
  insert into public.domain_events (account_id, type, entity_type, entity_id, payload, actor_type, actor_id)
  values (p_account_id, p_type, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb),
          v_actor.actor_type, v_actor.actor_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- Subscription patterns: '*' (everything), 'reservation.*' (prefix), or an exact type.
create or replace function private.event_type_matches(p_patterns text[], p_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(coalesce(p_patterns, '{}')) as p
    where p = '*'
       or p = p_type
       or (right(p, 2) = '.*' and starts_with(p_type, left(p, -1)))
  )
$$;

-- ---------------------------------------------------------------------------
-- Internal bus
-- ---------------------------------------------------------------------------

-- Global registry of internal consumers (not account data). Registered by migrations together
-- with the TypeScript handler of the same name (src/lib/events/consumers.ts).
create table public.event_consumers (
  name text primary key check (name ~ '^[a-z][a-z0-9_-]*$'),
  event_types text[] not null default '{*}' check (cardinality(event_types) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.event_queue (
  id bigint generated always as identity primary key,
  consumer text not null references public.event_consumers (name),
  event_id uuid not null references public.domain_events (id),
  account_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (consumer, event_id)
);

create index event_queue_due_idx on public.event_queue (consumer, next_attempt_at, id)
  where status in ('pending', 'processing');

-- Internal tables: RLS on with no policies = no access for anon/authenticated.
alter table public.event_consumers enable row level security;
alter table public.event_queue enable row level security;
revoke all on public.event_consumers, public.event_queue from anon, authenticated;

create or replace function private.fanout_events_to_consumers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.event_queue (consumer, event_id, account_id)
  select c.name, e.id, e.account_id
  from new_events e
  join public.event_consumers c
    on c.active and private.event_type_matches(c.event_types, e.type)
  on conflict (consumer, event_id) do nothing;
  return null;
end;
$$;

create trigger domain_events_fanout_consumers
  after insert on public.domain_events
  referencing new table as new_events
  for each statement execute function private.fanout_events_to_consumers();

-- Worker API (service role only) ------------------------------------------------

create or replace function public.claim_events(
  p_consumer text,
  p_limit integer default 100,
  p_lease_seconds integer default 60
)
returns table (queue_id bigint, attempts integer, event jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id
    from public.event_queue q
    where q.consumer = p_consumer
      and q.status in ('pending', 'processing')
      and q.next_attempt_at <= now()
      and (q.locked_until is null or q.locked_until < now())
    order by q.id
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  claimed as (
    update public.event_queue q
    set status = 'processing',
        attempts = q.attempts + 1,
        locked_until = now() + make_interval(secs => p_lease_seconds)
    from due
    where q.id = due.id
    returning q.id, q.attempts, q.event_id
  )
  select c.id, c.attempts, private.event_envelope(e)
  from claimed c
  join public.domain_events e on e.id = c.event_id
  order by e.seq;
end;
$$;

-- p_success: done. Otherwise retry at p_retry_at, or mark failed when p_retry_at is null.
create or replace function public.complete_event(
  p_queue_id bigint,
  p_success boolean,
  p_error text default null,
  p_retry_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.event_queue
  set status = case
                 when p_success then 'done'
                 when p_retry_at is null then 'failed'
                 else 'pending'
               end,
      processed_at = case when p_success or p_retry_at is null then now() end,
      next_attempt_at = coalesce(case when not p_success then p_retry_at end, next_attempt_at),
      locked_until = null,
      last_error = case when p_success then null else left(p_error, 2000) end
  where id = p_queue_id;
  if not found then
    raise exception 'event queue item % not found', p_queue_id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.claim_events(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.complete_event(bigint, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_events(text, integer, integer) to service_role;
grant execute on function public.complete_event(bigint, boolean, text, timestamptz) to service_role;

revoke execute on all functions in schema private from public;
