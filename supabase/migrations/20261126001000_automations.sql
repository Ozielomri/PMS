-- Step 7 / AUT-01 … AUT-07, AUT-09 … AUT-13: automation rules and their per-reservation jobs.
-- Design: docs/plans/step-7-automations.md.
--   * automation_rules: trigger + offset (+ fixed local time) + conditions → action.
--   * automation_jobs: one per rule × reservation × trigger occurrence (AUT-07), kept in sync with
--     the reservation by a trigger on public.reservations (AUT-03) and with the rule by a trigger
--     on public.automation_rules (AUT-02, pause/resume/edit).
-- The worker (/api/internal/automations/run) claims due jobs, renders them and completes them
-- through public.complete_automation_job.

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'paused')),
  trigger text not null check (trigger in ('reservation_created', 'reservation_confirmed', 'reservation_canceled',
                                           'dates_changed', 'check_in', 'check_out')),
  -- Signed: negative = before the trigger. With at_time it is a whole number of days.
  offset_minutes integer not null default 0 check (offset_minutes between -525600 and 525600),
  at_time time,
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  -- AUT-09: don't run a job more than this many hours after its scheduled time.
  expire_after_hours integer check (expire_after_hours is null or expire_after_hours between 1 and 720),
  starter_key text check (starter_key is null or starter_key ~ '^[a-z_]{1,40}$'),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, account_id),
  constraint automation_rules_at_time_days check (at_time is null or offset_minutes % 1440 = 0)
);

comment on table public.automation_rules is
  'AUT: automation rules. Deleted rules are kept (deleted_at) so their jobs and history stay readable.';

create index automation_rules_account_idx on public.automation_rules (account_id) where deleted_at is null;

create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  rule_id uuid not null,
  reservation_id uuid not null,
  -- check_in / check_out / reservation_created / reservation_confirmed / reservation_canceled /
  -- dates_changed:<epoch>. One job per rule, reservation and occurrence (AUT-07).
  occurrence text not null check (length(occurrence) between 1 and 80),
  -- Event time for event-triggered jobs (to recompute run_at when the rule's offset changes).
  anchor_at timestamptz,
  run_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'running', 'sent', 'failed', 'skipped', 'canceled')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_until timestamptz,
  -- AUT-06: this instance's edited content (replaces the rule's body for this job only).
  override_body text check (override_body is null or length(override_body) between 1 and 10000),
  reason text check (reason is null or length(reason) <= 1000),
  message_id uuid,
  proposal_id uuid,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, reservation_id, occurrence),
  foreign key (rule_id, account_id) references public.automation_rules (id, account_id),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id),
  foreign key (message_id, account_id) references public.messages (id, account_id),
  foreign key (proposal_id) references public.agent_proposals (id)
);

comment on table public.automation_jobs is 'AUT: one scheduled run of a rule for a reservation. Never deleted.';

create index automation_jobs_due_idx on public.automation_jobs (run_at) where status in ('scheduled', 'running');
create index automation_jobs_reservation_idx on public.automation_jobs (reservation_id, run_at);
create index automation_jobs_account_idx on public.automation_jobs (account_id, run_at desc);

create trigger automation_rules_touch before update on public.automation_rules
  for each row execute function private.touch_updated_at();
create trigger automation_jobs_touch before update on public.automation_jobs
  for each row execute function private.touch_updated_at();
create trigger audit_automation_rules after insert or update or delete on public.automation_rules
  for each row execute function private.audit_row_change();
create trigger audit_automation_jobs after insert or update or delete on public.automation_jobs
  for each row execute function private.audit_row_change();
create trigger events_automation_rules after insert or update on public.automation_rules
  for each row execute function private.emit_row_event('automation_rule');
create trigger events_automation_jobs after insert or update on public.automation_jobs
  for each row execute function private.emit_row_event('automation_job', 'locked_until');

create or replace function private.automation_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are never deleted', tg_table_name using errcode = '42501';
end;
$$;

create trigger automation_rules_no_delete before delete on public.automation_rules
  for each row execute function private.automation_no_delete();
create trigger automation_jobs_no_delete before delete on public.automation_jobs
  for each row execute function private.automation_no_delete();

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

-- Builds a rule from the builder payload and checks it. Raises on anything invalid.
create or replace function private.automation_rule_from_payload(p_account_id uuid, p_payload jsonb)
returns public.automation_rules
language plpgsql
set search_path = ''
as $$
declare
  v public.automation_rules;
  v_action jsonb := coalesce(p_payload -> 'action', '{}'::jsonb);
  v_cond jsonb := coalesce(p_payload -> 'conditions', '{}'::jsonb);
  v_key text;
  v_value jsonb;
begin
  v.id := gen_random_uuid();
  v.account_id := p_account_id;
  v.name := btrim(coalesce(p_payload ->> 'name', ''));
  v.status := coalesce(p_payload ->> 'status', 'active');
  v.trigger := p_payload ->> 'trigger';
  v.offset_minutes := coalesce((p_payload ->> 'offset_minutes')::integer, 0);
  v.at_time := nullif(p_payload ->> 'at_time', '')::time;
  v.expire_after_hours := nullif(p_payload ->> 'expire_after_hours', '')::integer;
  v.starter_key := nullif(p_payload ->> 'starter_key', '');
  v.conditions := v_cond;
  v.action := v_action;

  if length(v.name) not between 1 and 120 then
    raise exception 'invalid_rule: give the rule a name' using errcode = '22023';
  end if;
  if v.trigger is null or v.trigger not in ('reservation_created', 'reservation_confirmed', 'reservation_canceled', 'dates_changed', 'check_in', 'check_out') then
    raise exception 'invalid_rule: choose a trigger' using errcode = '22023';
  end if;
  if v.trigger not in ('check_in', 'check_out') and v.offset_minutes < 0 then
    raise exception 'invalid_rule: event triggers can only run at or after the event' using errcode = '22023';
  end if;
  if v.at_time is not null and v.offset_minutes % 1440 <> 0 then
    raise exception 'invalid_rule: with a fixed time the offset is a number of days' using errcode = '22023';
  end if;

  if jsonb_typeof(v_cond) <> 'object' then
    raise exception 'invalid_rule: conditions must be an object' using errcode = '22023';
  end if;
  for v_key, v_value in select * from jsonb_each(v_cond) loop
    if v_key in ('listing_ids', 'exclude_listing_ids', 'tags', 'exclude_tags', 'sources', 'languages') then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 500
         or exists (select 1 from jsonb_array_elements(v_value) e where jsonb_typeof(e) <> 'string') then
        raise exception 'invalid_rule: % must be a list', v_key using errcode = '22023';
      end if;
    elsif v_key in ('min_nights', 'max_nights', 'min_guests', 'max_guests', 'min_lead_days', 'max_lead_days') then
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric not between 0 and 1000 then
        raise exception 'invalid_rule: % must be a number from 0 to 1000', v_key using errcode = '22023';
      end if;
    else
      raise exception 'invalid_rule: unknown condition %', v_key using errcode = '22023';
    end if;
  end loop;

  case v_action ->> 'kind'
    when 'message' then
      if coalesce(v_action ->> 'recipient', '') not in ('guest', 'email') then
        raise exception 'invalid_rule: send to the guest or to an email address' using errcode = '22023';
      end if;
      if v_action ->> 'recipient' = 'email'
         and coalesce(v_action ->> 'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'invalid_rule: enter a valid email address' using errcode = '22023';
      end if;
      if length(btrim(coalesce(v_action ->> 'body', ''))) not between 1 and 10000 then
        raise exception 'invalid_rule: write the message' using errcode = '22023';
      end if;
      if length(coalesce(v_action ->> 'subject', '')) > 300 then
        raise exception 'invalid_rule: the subject is too long' using errcode = '22023';
      end if;
      if v_action ? 'variants' then
        if jsonb_typeof(v_action -> 'variants') <> 'object' then
          raise exception 'invalid_rule: variants must be an object' using errcode = '22023';
        end if;
        for v_key, v_value in select * from jsonb_each(v_action -> 'variants') loop
          if v_key !~ '^[a-z]{2}(-[A-Z]{2})?$' or jsonb_typeof(v_value) <> 'string'
             or length(btrim(v_value #>> '{}')) not between 1 and 10000 then
            raise exception 'invalid_rule: language variant %', v_key using errcode = '22023';
          end if;
        end loop;
      end if;
    when 'agent_draft' then
      if length(btrim(coalesce(v_action ->> 'instructions', ''))) not between 1 and 2000 then
        raise exception 'invalid_rule: tell the agent what to draft' using errcode = '22023';
      end if;
    else
      raise exception 'invalid_rule: choose an action' using errcode = '22023';
  end case;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Matching and timing
-- ---------------------------------------------------------------------------

create or replace function private.automation_rule_matches(p_rule public.automation_rules, p_r public.reservations)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_rule.conditions;
  v_l public.listings;
  v_tags text[];
  v_lang text;
  v_tz text;
  v_lead integer;
  v_guests integer := p_r.adults + p_r.children;
begin
  if p_r.kind <> 'guest' or p_r.guest_id is null then
    return false;
  end if;
  select * into v_l from public.listings where id = p_r.listing_id;
  v_tags := v_l.tags || coalesce((select p.tags from public.listings p where p.id = v_l.parent_id), '{}')
            || coalesce((select u.tags from public.listings u where u.id = p_r.unit_id), '{}');
  if c ? 'listing_ids' and jsonb_array_length(c -> 'listing_ids') > 0
     and not (c -> 'listing_ids' ?| array[p_r.listing_id::text, coalesce(p_r.unit_id::text, ''), coalesce(v_l.parent_id::text, '')]) then
    return false;
  end if;
  if c ? 'exclude_listing_ids'
     and (c -> 'exclude_listing_ids' ?| array[p_r.listing_id::text, coalesce(p_r.unit_id::text, ''), coalesce(v_l.parent_id::text, '')]) then
    return false;
  end if;
  if c ? 'tags' and jsonb_array_length(c -> 'tags') > 0 and not (c -> 'tags' ?| v_tags) then
    return false;
  end if;
  if c ? 'exclude_tags' and (c -> 'exclude_tags' ?| v_tags) then
    return false;
  end if;
  if c ? 'sources' and jsonb_array_length(c -> 'sources') > 0 and not (c -> 'sources' ? p_r.source) then
    return false;
  end if;
  if (c ? 'min_nights' and p_r.nights < (c ->> 'min_nights')::numeric)
     or (c ? 'max_nights' and p_r.nights > (c ->> 'max_nights')::numeric)
     or (c ? 'min_guests' and v_guests < (c ->> 'min_guests')::numeric)
     or (c ? 'max_guests' and v_guests > (c ->> 'max_guests')::numeric) then
    return false;
  end if;
  if c ? 'languages' and jsonb_array_length(c -> 'languages') > 0 then
    select g.language into v_lang from public.guests g where g.id = p_r.guest_id;
    if v_lang is null or not (c -> 'languages' ? split_part(v_lang, '-', 1)) and not (c -> 'languages' ? v_lang) then
      return false;
    end if;
  end if;
  if c ? 'min_lead_days' or c ? 'max_lead_days' then
    v_tz := (private.rules_listing(v_l)).timezone;
    v_lead := p_r.check_in - (p_r.created_at at time zone v_tz)::date;
    if (c ? 'min_lead_days' and v_lead < (c ->> 'min_lead_days')::numeric)
       or (c ? 'max_lead_days' and v_lead > (c ->> 'max_lead_days')::numeric) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

-- AUT-04: when a job of this rule runs for this reservation. Check-in/out anchors use ETA/ETD,
-- else the listing's default times (the parent's for sub-units), in the listing timezone. Event
-- triggers anchor on the event time (p_event_at).
create or replace function private.automation_run_at(p_rule public.automation_rules, p_r public.reservations, p_event_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l public.listings;
  v_rules public.listings;
  v_tz text;
  v_anchor timestamptz;
  v_date date;
begin
  select * into v_l from public.listings where id = p_r.listing_id;
  v_rules := private.rules_listing(v_l);
  v_tz := coalesce(v_rules.timezone, v_l.timezone, 'America/New_York');
  if p_rule.trigger = 'check_in' then
    v_date := p_r.check_in;
    v_anchor := (p_r.check_in + coalesce(p_r.eta, v_rules.check_in_from, time '16:00')) at time zone v_tz;
  elsif p_rule.trigger = 'check_out' then
    v_date := p_r.check_out;
    v_anchor := (p_r.check_out + coalesce(p_r.etd, v_rules.check_out_by, time '11:00')) at time zone v_tz;
  else
    v_anchor := coalesce(p_event_at, now());
    v_date := (v_anchor at time zone v_tz)::date;
  end if;
  if p_rule.at_time is not null then
    return ((v_date + (p_rule.offset_minutes / 1440)) + p_rule.at_time) at time zone v_tz;
  end if;
  return v_anchor + make_interval(mins => p_rule.offset_minutes);
end;
$$;

-- ---------------------------------------------------------------------------
-- Keeping jobs in sync (AUT-02, AUT-03, AUT-05)
-- ---------------------------------------------------------------------------

-- Re-evaluates the account's active rules (or one rule) for a reservation. p_event names a trigger
-- event that just happened (reservation_created / _confirmed / _canceled / dates_changed).
create or replace function private.automation_sync(p_r public.reservations, p_rule_id uuid default null,
                                                   p_event text default null, p_event_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.automation_rules;
  v_job public.automation_jobs;
  v_matches boolean;
  v_want boolean;
  v_run timestamptz;
  v_occ text;
  v_final boolean := p_r.status in ('canceled', 'declined', 'expired', 'closed');
begin
  for v_rule in
    select * from public.automation_rules
    where account_id = p_r.account_id and status = 'active' and deleted_at is null
      and (p_rule_id is null or id = p_rule_id)
    order by created_at
  loop
    v_matches := private.automation_rule_matches(v_rule, p_r);

    if v_rule.trigger in ('check_in', 'check_out') then
      v_occ := v_rule.trigger;
      v_want := v_matches and p_r.status = 'confirmed' and p_r.stay_status is distinct from 'no_show';
      v_run := private.automation_run_at(v_rule, p_r, null);
      select * into v_job from public.automation_jobs
      where rule_id = v_rule.id and reservation_id = p_r.id and occurrence = v_occ for update;
      if v_want and v_run > now() then
        if v_job.id is null then
          insert into public.automation_jobs (account_id, rule_id, reservation_id, occurrence, run_at)
          values (p_r.account_id, v_rule.id, p_r.id, v_occ, v_run);
        elsif v_job.status = 'scheduled' and v_job.run_at <> v_run then
          update public.automation_jobs set run_at = v_run where id = v_job.id;
        elsif v_job.status = 'canceled' then
          update public.automation_jobs set status = 'scheduled', run_at = v_run, reason = null where id = v_job.id;
        end if;
      elsif v_job.id is not null and v_job.status = 'scheduled' then
        if not v_want then
          update public.automation_jobs
          set status = 'canceled',
              reason = case when v_final then 'Reservation ' || p_r.status::text
                            when p_r.status <> 'confirmed' then 'Reservation is not confirmed'
                            else 'No longer matches the rule' end
          where id = v_job.id;
        elsif v_run <> v_job.run_at then
          -- The new time is already past (e.g. check-in moved earlier): don't send late.
          update public.automation_jobs set status = 'canceled', reason = 'The new time has already passed' where id = v_job.id;
        end if;
      end if;
    else
      if p_event = v_rule.trigger and v_matches then
        v_occ := case when v_rule.trigger = 'dates_changed'
                      then 'dates_changed:' || floor(extract(epoch from coalesce(p_event_at, now())))::bigint
                      else v_rule.trigger end;
        v_run := greatest(private.automation_run_at(v_rule, p_r, coalesce(p_event_at, now())), now());
        insert into public.automation_jobs (account_id, rule_id, reservation_id, occurrence, anchor_at, run_at)
        values (p_r.account_id, v_rule.id, p_r.id, v_occ, coalesce(p_event_at, now()), v_run)
        on conflict (rule_id, reservation_id, occurrence) do nothing;
      elsif not v_matches then
        update public.automation_jobs set status = 'canceled', reason = 'No longer matches the rule'
        where rule_id = v_rule.id and reservation_id = p_r.id and status = 'scheduled';
      end if;
    end if;
  end loop;

  -- AUT-05: a canceled (or declined, expired, closed) reservation keeps only cancellation jobs.
  if v_final then
    update public.automation_jobs j
    set status = 'canceled', reason = 'Reservation ' || p_r.status::text
    from public.automation_rules ru
    where j.reservation_id = p_r.id and j.status = 'scheduled' and ru.id = j.rule_id
      and ru.trigger <> 'reservation_canceled' and (p_rule_id is null or ru.id = p_rule_id);
  end if;
end;
$$;

create or replace function private.automation_on_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.automation_rules r
                 where r.account_id = new.account_id and r.status = 'active' and r.deleted_at is null) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.automation_sync(new, null, 'reservation_created', now());
    if new.status = 'confirmed' then
      perform private.automation_sync(new, null, 'reservation_confirmed', now());
    end if;
    return null;
  end if;
  if new.status is distinct from old.status and new.status = 'confirmed' then
    perform private.automation_sync(new, null, 'reservation_confirmed', now());
  end if;
  if new.status is distinct from old.status and new.status = 'canceled' then
    perform private.automation_sync(new, null, 'reservation_canceled', now());
  end if;
  if (new.check_in, new.check_out) is distinct from (old.check_in, old.check_out) then
    perform private.automation_sync(new, null, 'dates_changed', now());
  end if;
  perform private.automation_sync(new);
  return null;
end;
$$;

create trigger automations_sync after insert or update on public.reservations
  for each row execute function private.automation_on_reservation();

-- A rule was created, edited, paused, resumed or deleted: reschedule its pending jobs (AUT-02,
-- business rules: edits apply to jobs not yet executed; pausing cancels pending jobs; resuming
-- schedules future ones). Event-triggered jobs are only created when the event happens.
create or replace function private.automation_schedule_rule(p_rule_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.automation_rules;
  v_r public.reservations;
  v_count integer := 0;
begin
  select * into v_rule from public.automation_rules where id = p_rule_id;
  if v_rule.status <> 'active' or v_rule.deleted_at is not null then
    update public.automation_jobs
    set status = 'canceled', reason = case when v_rule.deleted_at is not null then 'Rule deleted' else 'Rule paused' end
    where rule_id = v_rule.id and status = 'scheduled';
    return 0;
  end if;
  if v_rule.trigger not in ('check_in', 'check_out') then
    update public.automation_jobs j
    set run_at = greatest(private.automation_run_at(v_rule, r, j.anchor_at), now())
    from public.reservations r
    where j.rule_id = v_rule.id and j.status = 'scheduled' and r.id = j.reservation_id;
  end if;
  for v_r in
    select r.* from public.reservations r
    join public.listings l on l.id = r.listing_id
    where r.account_id = v_rule.account_id and r.kind = 'guest'
      and (r.status = 'confirmed' or exists (select 1 from public.automation_jobs j where j.rule_id = v_rule.id and j.reservation_id = r.id and j.status = 'scheduled'))
      and r.check_out >= (now() at time zone l.timezone)::date - 30
  loop
    perform private.automation_sync(v_r, v_rule.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.automation_on_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or (new.status, new.trigger, new.offset_minutes, new.at_time, new.conditions, new.deleted_at)
        is distinct from (old.status, old.trigger, old.offset_minutes, old.at_time, old.conditions, old.deleted_at) then
    perform private.automation_schedule_rule(new.id);
  end if;
  return null;
end;
$$;

create trigger automation_rules_schedule after insert or update on public.automation_rules
  for each row execute function private.automation_on_rule();

-- ---------------------------------------------------------------------------
-- User RPCs (AUT-01, AUT-06, AUT-10)
-- ---------------------------------------------------------------------------

create or replace function public.save_automation_rule(p_account_id uuid, p_rule_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_rules;
  v_old public.automation_rules;
begin
  if not private.has_permission(p_account_id, 'automations.edit') then
    raise exception 'forbidden: automations.edit' using errcode = '42501';
  end if;
  v := private.automation_rule_from_payload(p_account_id, p_payload);
  if v.status not in ('active', 'paused') then
    raise exception 'invalid_rule: status' using errcode = '22023';
  end if;
  if p_rule_id is null then
    insert into public.automation_rules (account_id, name, status, trigger, offset_minutes, at_time, conditions, action, expire_after_hours, starter_key)
    values (p_account_id, v.name, v.status, v.trigger, v.offset_minutes, v.at_time, v.conditions, v.action, v.expire_after_hours, v.starter_key)
    returning id into v.id;
    return v.id;
  end if;
  select * into v_old from public.automation_rules where id = p_rule_id and account_id = p_account_id and deleted_at is null for update;
  if not found then
    raise exception 'rule_not_found' using errcode = 'P0002';
  end if;
  update public.automation_rules
  set name = v.name, status = v.status, trigger = v.trigger, offset_minutes = v.offset_minutes, at_time = v.at_time,
      conditions = v.conditions, action = v.action, expire_after_hours = v.expire_after_hours
  where id = p_rule_id;
  return p_rule_id;
end;
$$;

create or replace function private.automation_rule_authorize(p_rule_id uuid, p_permission text)
returns public.automation_rules
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.automation_rules;
begin
  select * into v from public.automation_rules where id = p_rule_id and deleted_at is null;
  if not found or not private.has_permission(v.account_id, 'automations.view') then
    raise exception 'rule_not_found' using errcode = 'P0002';
  end if;
  if not private.has_permission(v.account_id, p_permission) then
    raise exception 'forbidden: %', p_permission using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function public.set_automation_rule_status(p_rule_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_rules := private.automation_rule_authorize(p_rule_id, 'automations.edit');
begin
  if p_status not in ('active', 'paused') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  update public.automation_rules set status = p_status where id = v.id and status <> p_status;
end;
$$;

create or replace function public.delete_automation_rule(p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_rules := private.automation_rule_authorize(p_rule_id, 'automations.manage');
begin
  update public.automation_rules set deleted_at = now(), status = 'paused' where id = v.id;
end;
$$;

create or replace function private.automation_job_authorize(p_job_id uuid)
returns public.automation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs;
begin
  select * into v from public.automation_jobs where id = p_job_id for update;
  if not found or not exists (select 1 from public.reservations r where r.id = v.reservation_id
                                and private.can_view_reservation(r.account_id, r.listing_id))
     or not private.has_permission(v.account_id, 'automations.view') then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;
  if not private.has_permission(v.account_id, 'automations.edit') then
    raise exception 'forbidden: automations.edit' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- AUT-06 skip one scheduled run.
create or replace function public.skip_automation_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs := private.automation_job_authorize(p_job_id);
begin
  if v.status <> 'scheduled' then
    raise exception 'job_not_scheduled: this run is %', v.status using errcode = '55000';
  end if;
  update public.automation_jobs set status = 'skipped', reason = 'Skipped by a team member' where id = v.id;
end;
$$;

-- AUT-06 send now (also retries a failed run).
create or replace function public.send_automation_job_now(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs := private.automation_job_authorize(p_job_id);
begin
  if v.status not in ('scheduled', 'failed') then
    raise exception 'job_not_scheduled: this run is %', v.status using errcode = '55000';
  end if;
  update public.automation_jobs set status = 'scheduled', run_at = now(), reason = null where id = v.id;
end;
$$;

-- AUT-06 edit this one message (the rule stays as it is).
create or replace function public.edit_automation_job(p_job_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs := private.automation_job_authorize(p_job_id);
begin
  if v.status not in ('scheduled', 'failed') then
    raise exception 'job_not_scheduled: this run is %', v.status using errcode = '55000';
  end if;
  update public.automation_jobs set override_body = nullif(btrim(p_body), '') where id = v.id;
end;
$$;

-- AUT-10 (builder review step): how many reservations the rule would apply to now, and the next
-- few runs. Nothing is written.
create or replace function public.preview_automation_rule(p_account_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.automation_rules;
  v_count integer;
  v_next jsonb;
begin
  if not private.has_permission(p_account_id, 'automations.view') then
    raise exception 'forbidden: automations.view' using errcode = '42501';
  end if;
  v := private.automation_rule_from_payload(p_account_id, p_payload);
  with candidates as (
    select r.*, case when v.trigger in ('check_in', 'check_out') then private.automation_run_at(v, r, null) end as run_at
    from public.reservations r
    join public.listings l on l.id = r.listing_id
    where r.account_id = p_account_id and r.kind = 'guest' and r.status in ('inquiry', 'reserved', 'confirmed')
      and r.check_out >= (now() at time zone l.timezone)::date
      and private.can_view_reservation(r.account_id, r.listing_id)
      and private.automation_rule_matches(v, r)
  ), applicable as (
    select * from candidates c
    where case when v.trigger in ('check_in', 'check_out') then c.status = 'confirmed' and c.run_at > now() else true end
  )
  select count(*)::integer,
         coalesce((select jsonb_agg(jsonb_build_object('reservation_id', a.id, 'code', a.code, 'run_at', a.run_at) order by a.run_at)
                   from (select * from applicable where run_at is not null order by run_at limit 5) a), '[]'::jsonb)
  into v_count, v_next
  from applicable;
  return jsonb_build_object('count', v_count, 'next', v_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs (service role)
-- ---------------------------------------------------------------------------

-- Claims due jobs with a lease (FOR UPDATE SKIP LOCKED): overlapping workers never run a job
-- twice (AUT-07). Jobs later than their rule's expiry are skipped first (AUT-09).
create or replace function public.claim_automation_jobs(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (
  job_id uuid,
  attempts integer,
  account_id uuid,
  rule_id uuid,
  reservation_id uuid,
  run_at timestamptz,
  action jsonb,
  override_body text,
  created_by uuid,
  guest_language text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.automation_jobs j
  set status = 'skipped', reason = format('Expired: more than %s hours late', ru.expire_after_hours)
  from public.automation_rules ru
  where ru.id = j.rule_id and j.status = 'scheduled' and ru.expire_after_hours is not null
    and j.run_at + make_interval(hours => ru.expire_after_hours) < now();

  return query
  with due as (
    select j.id from public.automation_jobs j
    where (j.status = 'scheduled' and j.run_at <= now()) or (j.status = 'running' and j.locked_until < now())
    order by j.run_at
    limit greatest(least(coalesce(p_limit, 25), 200), 1)
    for update skip locked
  ),
  claimed as (
    update public.automation_jobs j
    set status = 'running', attempts = j.attempts + 1,
        locked_until = now() + make_interval(secs => greatest(least(coalesce(p_lease_seconds, 120), 900), 10))
    from due where j.id = due.id
    returning j.*
  )
  select c.id, c.attempts, c.account_id, c.rule_id, c.reservation_id, c.run_at, ru.action, c.override_body, ru.created_by, g.language
  from claimed c
  join public.automation_rules ru on ru.id = c.rule_id
  join public.reservations r on r.id = c.reservation_id
  left join public.guests g on g.id = r.guest_id;
end;
$$;

-- Completes a claimed job. For a message to the guest it writes the outbound message into the
-- reservation's conversation (author: automation) and queues its delivery, in the same
-- transaction. Returns false when the job is no longer this worker's (lease lost).
create or replace function public.complete_automation_job(
  p_job_id uuid,
  p_attempt integer,
  p_outcome text,
  p_body text default null,
  p_subject text default null,
  p_reason text default null,
  p_proposal_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs;
  v_rule public.automation_rules;
  v_r public.reservations;
  v_c public.conversations;
  v_g public.guests;
  v_to text;
  v_msg uuid;
begin
  if p_outcome not in ('sent', 'failed', 'skipped') then
    raise exception 'invalid_outcome: %', p_outcome using errcode = '22023';
  end if;
  select * into v from public.automation_jobs where id = p_job_id for update;
  if not found or v.status <> 'running' or v.attempts <> p_attempt then
    return false;
  end if;
  if p_outcome <> 'sent' then
    update public.automation_jobs
    set status = p_outcome, reason = left(coalesce(p_reason, initcap(p_outcome)), 1000), executed_at = now(), locked_until = null
    where id = v.id;
    return true;
  end if;

  select * into v_rule from public.automation_rules where id = v.rule_id;
  if v_rule.action ->> 'kind' = 'message' and v_rule.action ->> 'recipient' = 'guest' then
    if p_body is null or btrim(p_body) = '' or private.has_unresolved_variables(p_body) then
      raise exception 'unresolved_variables: the message still has variables' using errcode = '22023';
    end if;
    select * into v_r from public.reservations where id = v.reservation_id;
    v_c := private.reservation_conversation(v_r);
    select * into v_g from public.guests where id = v_r.guest_id;
    v_to := coalesce(v_c.contact_email, v_g.email);
    if v_to is null then
      update public.automation_jobs set status = 'failed', reason = 'The guest has no email address', executed_at = now(), locked_until = null where id = v.id;
      return true;
    end if;
    insert into public.messages (account_id, conversation_id, kind, channel, author_type, recipient_email, subject, body)
    values (v.account_id, v_c.id, 'outbound', 'email', 'automation', v_to, left(coalesce(nullif(btrim(p_subject), ''), v_c.subject), 1000), p_body)
    returning id into v_msg;
    insert into public.message_deliveries (message_id, account_id, channel, to_address, to_name)
    values (v_msg, v.account_id, 'email', v_to, nullif(btrim(concat_ws(' ', v_g.first_name, v_g.last_name)), ''));
  end if;

  update public.automation_jobs
  set status = 'sent', message_id = v_msg, proposal_id = p_proposal_id, reason = left(p_reason, 1000), executed_at = now(), locked_until = null
  where id = v.id;
  return true;
end;
$$;

-- The conversation a running job writes into ("ask the agent" drafts). Service role only.
create or replace function public.automation_job_conversation(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.automation_jobs;
  v_r public.reservations;
begin
  select * into v from public.automation_jobs where id = p_job_id;
  if not found or v.status <> 'running' then
    raise exception 'job_not_running' using errcode = '55000';
  end if;
  select * into v_r from public.reservations where id = v.reservation_id;
  return (private.reservation_conversation(v_r)).id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.automation_rules enable row level security;
alter table public.automation_jobs enable row level security;

revoke all on public.automation_rules, public.automation_jobs from anon;
revoke insert, update, delete, truncate on public.automation_rules, public.automation_jobs from authenticated;

create policy automation_rules_select on public.automation_rules for select to authenticated
  using (private.has_permission(account_id, 'automations.view'));
create policy automation_jobs_select on public.automation_jobs for select to authenticated
  using (private.has_permission(account_id, 'automations.view')
         and exists (select 1 from public.reservations r where r.id = reservation_id));

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.save_automation_rule(uuid, uuid, jsonb)',
    'public.set_automation_rule_status(uuid, text)',
    'public.delete_automation_rule(uuid)',
    'public.skip_automation_job(uuid)',
    'public.send_automation_job_now(uuid)',
    'public.edit_automation_job(uuid, text)',
    'public.preview_automation_rule(uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.claim_automation_jobs(integer, integer)',
    'public.complete_automation_job(uuid, integer, text, text, text, text, uuid)',
    'public.automation_job_conversation(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.automation_jobs';
  end if;
end;
$$;

revoke execute on all functions in schema private from public;
