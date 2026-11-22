-- AI agent foundations (docs/plans/ai-agent.md), part 2: the agent's permissions (X-01), the
-- `agent` actor type in the audit log and events (X-03, X-04), and the guard that keeps the
-- role off human memberships. The approval queue (agent_proposals) follows in 20261125001300.

-- ---------------------------------------------------------------------------
-- Role permissions (TS mirror: src/lib/auth/permissions.ts, AGENT)
-- ---------------------------------------------------------------------------

-- Conservative: read what a guest-facing answer needs, reply in the inbox. No money, no edits,
-- no cancellations. The database refuses anything else the agent attempts.
insert into public.role_permissions (role, permission)
select 'agent'::public.account_role, p
from unnest(array[
  'account.view',
  'properties.view',
  'calendar.view',
  'reservations.view', 'reservations.view_next_guest',
  'inbox.view', 'inbox.reply'
]) as p;

-- The agent is not a person: it never holds a membership or an invitation.
alter table public.memberships add constraint memberships_not_agent check (role <> 'agent');
alter table public.invitations add constraint invitations_not_agent check (role <> 'agent');

-- ---------------------------------------------------------------------------
-- Actor type `agent`
-- ---------------------------------------------------------------------------

alter table public.audit_log drop constraint audit_log_actor_type_check;
alter table public.audit_log add constraint audit_log_actor_type_check
  check (actor_type in ('user', 'automation', 'channel', 'api', 'system', 'agent'));

-- Same as 000100, plus 'agent'. Non-user actors are only trusted from the service role or a
-- direct database connection.
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

  if actor_type is null or actor_type not in ('automation', 'channel', 'api', 'system', 'agent') then
    actor_type := 'system';
    actor_id := coalesce(actor_id, v_role);
  end if;
end;
$$;

-- Is the current request the agent, and does the agent role hold this permission?
-- Agent RPCs (service role) call this; the same role_permissions rows as for people apply.
create or replace function private.agent_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select a.actor_type from private.current_actor() a) = 'agent'
     and exists (select 1 from public.role_permissions rp where rp.role = 'agent' and rp.permission = p_permission)
$$;

revoke execute on all functions in schema private from public;

