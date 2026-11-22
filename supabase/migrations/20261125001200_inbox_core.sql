-- Step 6 / INB-01 … INB-11, INB-13 … INB-16: unified inbox, email first, AI drafts.
-- Design: docs/plans/step-6-inbox.md.
--   * conversations: one per guest per reservation (INB-02); inquiries and unknown senders start
--     a conversation without a reservation that attaches when the booking is created.
--   * messages: inbound, outbound and internal notes; append-only (never edited or deleted).
--   * message_deliveries: INB-10 delivery status machine, worked by an outbound queue worker.
--   * inbound_emails: raw log of every inbound email, matched or not (business rule: stored even
--     when the reservation or account is unknown).
--   * saved_replies (INB-05), conversation_reads (unread markers), agent_proposals (approval
--     queue of the AI agent; reply drafts first, never sent by the agent in this step).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Random lowercase token without look-alike characters (l, o, 0, 1): routing addresses.
create or replace function private.random_token(p_length integer)
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('abcdefghijkmnpqrstuvwxyz23456789', (get_byte(x.b, i) % 32) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(p_length) as b) x
  cross join generate_series(0, p_length - 1) i
$$;

-- Same pattern as src/lib/inbox/variables.ts VARIABLE_PATTERN.
create or replace function private.has_unresolved_variables(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_body ~ '\{\{\s*[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*\}\}'
$$;

-- ---------------------------------------------------------------------------
-- Inbox settings: per-account inbound address and the agent switch
-- ---------------------------------------------------------------------------

create table public.inbox_settings (
  account_id uuid primary key references public.accounts (id),
  id uuid not null default gen_random_uuid() unique,
  -- <inbound_token>@INBOX_INBOUND_DOMAIN receives guest email and forwarded mail.
  inbound_token text not null unique check (inbound_token ~ '^[a-z0-9]{10,32}$'),
  sender_name text check (sender_name is null or length(btrim(sender_name)) between 1 and 100),
  -- Kill switch for the AI agent in the inbox (docs/plans/ai-agent.md).
  ai_drafts_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger inbox_settings_touch before update on public.inbox_settings
  for each row execute function private.touch_updated_at();
create trigger audit_inbox_settings after insert or update or delete on public.inbox_settings
  for each row execute function private.audit_row_change();
-- Settings are created with the account (account.created covers that); changes emit events.
create trigger events_inbox_settings after update on public.inbox_settings
  for each row execute function private.emit_row_event('inbox_settings');

create or replace function private.create_inbox_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.inbox_settings (account_id, inbound_token) values (new.id, private.random_token(10))
  on conflict (account_id) do nothing;
  return null;
end;
$$;

create trigger accounts_inbox_settings after insert on public.accounts
  for each row execute function private.create_inbox_settings();

insert into public.inbox_settings (account_id, inbound_token)
select a.id, private.random_token(10) from public.accounts a
on conflict (account_id) do nothing;

-- ---------------------------------------------------------------------------
-- Conversations (INB-01, INB-02, INB-08)
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  reservation_id uuid,
  guest_id uuid,
  -- Who we talk to when there is no guest record (inquiries by email), and the reply address.
  contact_name text check (contact_name is null or length(contact_name) <= 200),
  contact_email text check (contact_email is null or (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(contact_email) <= 254)),
  -- Originating channel = default reply channel. Booking.com etc. plug in with step 9.
  channel text not null default 'email' check (channel in ('email', 'booking_com', 'airbnb', 'vrbo', 'sms', 'whatsapp')),
  subject text check (subject is null or length(subject) <= 300),
  reply_token text not null unique check (reply_token ~ '^[a-z0-9]{10,32}$'),
  status text not null default 'open' check (status in ('open', 'done')),
  assignee_user_id uuid references public.profiles (user_id),
  tags text[] not null default '{}',
  -- Set by the first guest message after our last reply; cleared by a reply (Unanswered tab, INB-13).
  awaiting_reply_since timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_kind text check (last_message_kind is null or last_message_kind in ('inbound', 'outbound')),
  last_guest_message_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, account_id),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id),
  foreign key (guest_id, account_id) references public.guests (id, account_id),
  constraint conversations_reservation_guest check (reservation_id is null or guest_id is not null)
);

comment on table public.conversations is
  'INB: one conversation per guest per reservation; reservation_id null until an inquiry/unknown sender is matched.';

create unique index conversations_one_per_guest_reservation on public.conversations (reservation_id, guest_id)
  where reservation_id is not null;
create index conversations_account_activity_idx on public.conversations (account_id, last_message_at desc nulls last);
create index conversations_awaiting_idx on public.conversations (account_id, awaiting_reply_since) where awaiting_reply_since is not null;
create index conversations_contact_idx on public.conversations (account_id, contact_email) where reservation_id is null;
create index conversations_guest_idx on public.conversations (guest_id);
create index conversations_assignee_idx on public.conversations (assignee_user_id) where assignee_user_id is not null;

create or replace function private.conversation_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.tags := private.normalize_tags(new.tags);
  new.contact_email := nullif(lower(btrim(new.contact_email)), '');
  new.contact_name := nullif(btrim(new.contact_name), '');
  if tg_op = 'INSERT' then
    new.reply_token := coalesce(new.reply_token, private.random_token(12));
  else
    if new.account_id <> old.account_id or new.reply_token <> old.reply_token or new.created_at <> old.created_at then
      raise exception 'conversation identity cannot change' using errcode = '42501';
    end if;
    if old.reservation_id is not null and new.reservation_id is distinct from old.reservation_id then
      raise exception 'conversation_reservation_fixed: a conversation stays with its reservation' using errcode = '22023';
    end if;
  end if;
  if new.assignee_user_id is not null and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id) then
    if not exists (
      select 1 from public.memberships m
      join public.role_permissions rp on rp.role = m.role and rp.permission = 'inbox.view'
      where m.account_id = new.account_id and m.user_id = new.assignee_user_id and m.status = 'active'
    ) then
      raise exception 'not_a_member: the assignee must be a team member with inbox access' using errcode = '22023';
    end if;
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.done_at := now();
  elsif new.status = 'open' then
    new.done_at := null;
  end if;
  return new;
end;
$$;

create trigger conversations_rules before insert or update on public.conversations
  for each row execute function private.conversation_rules();
create trigger conversations_touch before update on public.conversations
  for each row execute function private.touch_updated_at();
create trigger audit_conversations after insert or update or delete on public.conversations
  for each row execute function private.audit_row_change();

create or replace function private.conversations_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'conversations are never deleted' using errcode = '42501';
end;
$$;

create trigger conversations_never_deleted before delete on public.conversations
  for each row execute function private.conversations_no_delete();

-- conversation.created / conversation.updated (status, assignment, tags, matching); the
-- per-message summary columns change with every message and are covered by message events.
create or replace function private.emit_conversation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := jsonb_build_object('status', new.status, 'assignee_user_id', new.assignee_user_id, 'tags', to_jsonb(new.tags),
                                    'reservation_id', new.reservation_id, 'guest_id', new.guest_id, 'channel', new.channel);
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.emit_event(new.account_id, 'conversation.created', 'conversation', new.id::text,
      jsonb_build_object('record', v_new || jsonb_build_object('id', new.id, 'contact_email', new.contact_email)));
    return null;
  end if;
  v_changes := private.row_diff(
    jsonb_build_object('status', old.status, 'assignee_user_id', old.assignee_user_id, 'tags', to_jsonb(old.tags),
                       'reservation_id', old.reservation_id, 'guest_id', old.guest_id, 'channel', old.channel),
    v_new);
  if v_changes <> '{}'::jsonb then
    perform private.emit_event(new.account_id, 'conversation.updated', 'conversation', new.id::text,
      jsonb_build_object('record', v_new || jsonb_build_object('id', new.id), 'changes', v_changes));
  end if;
  return null;
end;
$$;

create trigger events_conversations after insert or update on public.conversations
  for each row execute function private.emit_conversation_event();

-- ---------------------------------------------------------------------------
-- Raw inbound email log
-- ---------------------------------------------------------------------------

create table public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  -- null: no account could be identified (wrong address); kept for troubleshooting, service role only.
  account_id uuid references public.accounts (id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,30}$'),
  provider_message_id text not null check (length(provider_message_id) between 1 and 500),
  received_at timestamptz not null default now(),
  from_email text not null,
  from_name text,
  to_addresses text[] not null default '{}',
  subject text,
  rfc_message_id text,
  status text not null check (status in ('matched', 'unmatched')),
  match_method text check (match_method is null or match_method in
    ('reply_token_address', 'reply_token_subject', 'thread_header', 'guest_email', 'contact_email', 'new_conversation')),
  conversation_id uuid references public.conversations (id),
  message_id uuid,
  payload jsonb not null default '{}'::jsonb,
  unique (provider, provider_message_id),
  constraint inbound_emails_match check ((status = 'matched') = (conversation_id is not null and match_method is not null))
);

create index inbound_emails_account_idx on public.inbound_emails (account_id, received_at desc);

create trigger inbound_emails_append_only before update or delete on public.inbound_emails
  for each row execute function private.append_only();
create trigger audit_inbound_emails after insert on public.inbound_emails
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Messages (append-only)
-- ---------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  conversation_id uuid not null,
  kind text not null check (kind in ('inbound', 'outbound', 'note')),
  channel text not null check (channel in ('email', 'booking_com', 'airbnb', 'vrbo', 'sms', 'whatsapp', 'internal')),
  author_type text not null check (author_type in ('guest', 'user', 'agent', 'automation', 'system')),
  author_user_id uuid references public.profiles (user_id),
  sender_name text check (sender_name is null or length(sender_name) <= 200),
  sender_email text check (sender_email is null or length(sender_email) <= 254),
  recipient_email text check (recipient_email is null or length(recipient_email) <= 254),
  subject text check (subject is null or length(subject) <= 1000),
  body text not null check (length(body) between 1 and 20000),
  -- The template the user wrote ({{variables}} unresolved); the body is what the guest gets.
  body_template text check (body_template is null or length(body_template) <= 20000),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  mentions uuid[] not null default '{}',
  saved_reply_id uuid,
  proposal_id uuid,
  rfc_message_id text check (rfc_message_id is null or length(rfc_message_id) <= 1000),
  in_reply_to text check (in_reply_to is null or length(in_reply_to) <= 1000),
  inbound_email_id uuid references public.inbound_emails (id),
  -- INB-13: seconds from the guest message that started the wait to this reply.
  response_seconds integer check (response_seconds is null or response_seconds >= 0),
  created_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(subject, '') || ' ' || body)) stored,
  unique (id, account_id),
  foreign key (conversation_id, account_id) references public.conversations (id, account_id),
  constraint messages_note_internal check ((kind = 'note') = (channel = 'internal')),
  -- INB-06: a reply with an unresolved variable cannot be sent, whatever path it takes.
  constraint messages_no_unresolved_variables check (kind <> 'outbound' or body !~ '\{\{\s*[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*\}\}')
);

comment on table public.messages is 'INB: guest messages, replies and internal notes. Append-only.';

create index messages_conversation_idx on public.messages (conversation_id, created_at, id);
create index messages_account_time_idx on public.messages (account_id, created_at desc);
create index messages_rfc_idx on public.messages (account_id, rfc_message_id) where rfc_message_id is not null;
create index messages_search_idx on public.messages using gin (search);
create index messages_author_idx on public.messages (author_user_id, created_at desc) where author_user_id is not null;

create trigger messages_append_only before update or delete on public.messages
  for each row execute function private.append_only();
create trigger audit_messages after insert on public.messages
  for each row execute function private.audit_row_change();

create or replace function private.message_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = new.conversation_id for update;
  if not found or v_c.account_id <> new.account_id then
    raise exception 'conversation_not_found: %', new.conversation_id using errcode = 'P0002';
  end if;
  new.created_at := now();
  if new.kind = 'outbound' then
    new.rfc_message_id := coalesce(new.rfc_message_id, '<' || new.id::text || '@pms>');
    if v_c.awaiting_reply_since is not null then
      new.response_seconds := greatest(0, floor(extract(epoch from (new.created_at - v_c.awaiting_reply_since))))::integer;
    end if;
  end if;
  return new;
end;
$$;

create trigger messages_before_insert before insert on public.messages
  for each row execute function private.message_before_insert();

create or replace function private.message_event_payload(p_m public.messages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'message', jsonb_build_object(
      'id', p_m.id, 'conversation_id', p_m.conversation_id, 'kind', p_m.kind, 'channel', p_m.channel,
      'author_type', p_m.author_type, 'author_user_id', p_m.author_user_id, 'sender_email', p_m.sender_email,
      'subject', p_m.subject, 'body', p_m.body, 'mentions', to_jsonb(p_m.mentions), 'created_at', p_m.created_at),
    'conversation', jsonb_build_object(
      'id', c.id, 'reservation_id', c.reservation_id, 'guest_id', c.guest_id, 'status', c.status, 'assignee_user_id', c.assignee_user_id))
  from public.conversations c where c.id = p_m.conversation_id
$$;

-- Keeps the conversation summary current, reopens Done conversations on a guest message (INB-08)
-- and emits message.received / message.note_added (INB-16).
create or replace function private.message_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'inbound' then
    update public.conversations c
    set last_message_at = new.created_at,
        last_message_preview = left(regexp_replace(new.body, '\s+', ' ', 'g'), 200),
        last_message_kind = 'inbound',
        last_guest_message_at = new.created_at,
        awaiting_reply_since = coalesce(c.awaiting_reply_since, new.created_at),
        status = 'open',
        contact_email = coalesce(new.sender_email, c.contact_email),
        contact_name = coalesce(c.contact_name, new.sender_name)
    where c.id = new.conversation_id;
    perform private.emit_event(new.account_id, 'message.received', 'message', new.id::text, private.message_event_payload(new));
  elsif new.kind = 'outbound' then
    update public.conversations c
    set last_message_at = new.created_at,
        last_message_preview = left(regexp_replace(new.body, '\s+', ' ', 'g'), 200),
        last_message_kind = 'outbound',
        awaiting_reply_since = null
    where c.id = new.conversation_id;
  else
    perform private.emit_event(new.account_id, 'message.note_added', 'message', new.id::text, private.message_event_payload(new));
  end if;
  return null;
end;
$$;

create trigger messages_after_insert after insert on public.messages
  for each row execute function private.message_after_insert();

-- ---------------------------------------------------------------------------
-- Delivery status (INB-10)
-- ---------------------------------------------------------------------------

-- Mirrored in src/lib/inbox/delivery.ts (parity tested).
create or replace function private.delivery_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from, p_to) in (
    ('queued', 'sending'), ('queued', 'discarded'),
    ('sending', 'sending'), ('sending', 'sent'), ('sending', 'delivered'), ('sending', 'queued'), ('sending', 'failed'),
    ('sent', 'delivered'), ('sent', 'failed'),
    ('failed', 'queued'), ('failed', 'discarded')
  )
$$;

create table public.message_deliveries (
  message_id uuid primary key,
  account_id uuid not null,
  channel text not null check (channel in ('email', 'booking_com', 'airbnb', 'vrbo', 'sms', 'whatsapp')),
  to_address text not null check (length(to_address) between 3 and 254),
  to_name text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'discarded')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  provider text,
  provider_message_id text,
  last_error text check (last_error is null or length(last_error) <= 2000),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  discarded_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (message_id, account_id) references public.messages (id, account_id)
);

create index message_deliveries_due_idx on public.message_deliveries (next_attempt_at, message_id) where status in ('queued', 'sending');
create unique index message_deliveries_provider_idx on public.message_deliveries (provider, provider_message_id)
  where provider_message_id is not null;
create index message_deliveries_account_idx on public.message_deliveries (account_id, queued_at desc);
create index message_deliveries_failed_idx on public.message_deliveries (account_id) where status = 'failed';

create or replace function private.delivery_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then
      raise exception 'delivery_transition_invalid: a delivery starts queued' using errcode = '55000';
    end if;
    return new;
  end if;
  if new.message_id <> old.message_id or new.account_id <> old.account_id or new.to_address <> old.to_address or new.channel <> old.channel then
    raise exception 'delivery identity cannot change' using errcode = '42501';
  end if;
  if new.status <> old.status or new.status = 'sending' and old.status = 'sending' and new.attempts <> old.attempts then
    if not private.delivery_transition_allowed(old.status, new.status) then
      raise exception 'delivery_transition_invalid: % to %', old.status, new.status using errcode = '55000';
    end if;
  elsif old.status in ('delivered', 'discarded') then
    raise exception 'delivery_transition_invalid: % is final', old.status using errcode = '55000';
  end if;
  if new.status <> old.status then
    case new.status
      when 'sent' then new.sent_at := now();
      when 'delivered' then new.delivered_at := now(); new.sent_at := coalesce(old.sent_at, now());
      when 'failed' then new.failed_at := now();
      when 'discarded' then new.discarded_at := now();
      else null;
    end case;
  end if;
  if new.status <> 'sending' then
    new.locked_until := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger message_deliveries_rules before insert or update on public.message_deliveries
  for each row execute function private.delivery_rules();
create trigger audit_message_deliveries after insert or update or delete on public.message_deliveries
  for each row execute function private.audit_row_change();

create or replace function private.message_deliveries_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'message deliveries are never deleted; discard instead' using errcode = '42501';
end;
$$;

create trigger message_deliveries_never_deleted before delete on public.message_deliveries
  for each row execute function private.message_deliveries_no_delete();

-- message.queued / .sent / .delivered / .failed / .discarded (INB-16). The worker's internal
-- sending ↔ queued retries are in the audit log only.
create or replace function private.emit_delivery_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_payload jsonb;
begin
  if tg_op = 'UPDATE' then
    -- Worker internals (claim, lease takeover, scheduled retry) are in the audit log only.
    if new.status = old.status or new.status = 'sending' or (new.status = 'queued' and old.status = 'sending') then
      return null;
    end if;
  end if;
  select * into v_m from public.messages where id = new.message_id;
  v_payload := private.message_event_payload(v_m) || jsonb_build_object('delivery', jsonb_build_object(
    'status', new.status, 'to', new.to_address, 'attempts', new.attempts, 'error', new.last_error,
    'provider', new.provider, 'provider_message_id', new.provider_message_id));
  if new.status = 'queued' then
    perform private.emit_event(new.account_id, 'message.queued', 'message', new.message_id::text, v_payload);
    return null;
  end if;
  if new.status = 'sent' or (new.status = 'delivered' and old.status = 'sending') then
    perform private.emit_event(new.account_id, 'message.sent', 'message', new.message_id::text, v_payload);
  end if;
  if new.status in ('delivered', 'failed', 'discarded') then
    perform private.emit_event(new.account_id, 'message.' || new.status, 'message', new.message_id::text, v_payload);
  end if;
  return null;
end;
$$;

create trigger events_message_deliveries after insert or update on public.message_deliveries
  for each row execute function private.emit_delivery_event();

-- ---------------------------------------------------------------------------
-- Saved replies (INB-05)
-- ---------------------------------------------------------------------------

create table public.saved_replies (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  title text not null check (length(btrim(title)) between 1 and 100),
  -- Typed after "/" in the composer.
  shortcut text check (shortcut is null or shortcut ~ '^[a-z0-9][a-z0-9_-]{0,29}$'),
  body text not null check (length(btrim(body)) between 1 and 10000),
  language text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  -- Language variants: {"es": "Hola {{guest.first_name}}", ...}
  variants jsonb not null default '{}'::jsonb check (jsonb_typeof(variants) = 'object'),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, shortcut)
);

create index saved_replies_account_idx on public.saved_replies (account_id, lower(title)) where archived_at is null;

create or replace function private.saved_reply_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
begin
  new.title := btrim(new.title);
  new.shortcut := nullif(lower(btrim(new.shortcut)), '');
  for v_key, v_value in select * from jsonb_each(new.variants) loop
    if v_key !~ '^[a-z]{2}(-[A-Z]{2})?$' or v_key = new.language or jsonb_typeof(v_value) <> 'string'
       or length(btrim(v_value #>> '{}')) not between 1 and 10000 then
      raise exception 'invalid_variants: %', v_key using errcode = '22023';
    end if;
  end loop;
  if tg_op = 'UPDATE' and new.account_id <> old.account_id then
    raise exception 'saved reply account cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger saved_replies_rules before insert or update on public.saved_replies
  for each row execute function private.saved_reply_rules();
create trigger saved_replies_touch before update on public.saved_replies
  for each row execute function private.touch_updated_at();
create trigger audit_saved_replies after insert or update or delete on public.saved_replies
  for each row execute function private.audit_row_change();
create trigger events_saved_replies after insert or update on public.saved_replies
  for each row execute function private.emit_row_event('saved_reply');

-- ---------------------------------------------------------------------------
-- Per-user read markers (INB-01 unread). UI state: not audited, no events.
-- ---------------------------------------------------------------------------

create table public.conversation_reads (
  conversation_id uuid not null,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  account_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id),
  foreign key (conversation_id, account_id) references public.conversations (id, account_id)
);

-- ---------------------------------------------------------------------------
-- Agent approval queue (docs/plans/ai-agent.md). Reply drafts first (INB-11).
-- ---------------------------------------------------------------------------

create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  kind text not null check (kind in ('reply_draft')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'edited', 'rejected', 'superseded')),
  conversation_id uuid,
  reservation_id uuid,
  -- The exact call the agent proposes; approving runs it as the human (drafts: inbox_send_message).
  tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  tool_input jsonb not null check (jsonb_typeof(tool_input) = 'object'),
  content text check (content is null or length(content) <= 20000),
  reasoning_summary text check (reasoning_summary is null or length(reasoning_summary) <= 4000),
  confidence text check (confidence is null or confidence in ('high', 'medium', 'low')),
  needs_human boolean not null default false,
  -- What the model was given, by source (no raw guest data): for review and cost tracking.
  grounding jsonb not null default '{}'::jsonb check (jsonb_typeof(grounding) = 'object'),
  model text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  requested_by uuid references public.profiles (user_id),
  decided_by uuid references public.profiles (user_id),
  decided_at timestamptz,
  message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, account_id) references public.conversations (id, account_id),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id),
  foreign key (message_id, account_id) references public.messages (id, account_id)
);

create index agent_proposals_conversation_idx on public.agent_proposals (conversation_id, created_at desc);
create index agent_proposals_pending_idx on public.agent_proposals (account_id, created_at desc) where status = 'pending';

alter table public.messages
  add constraint messages_proposal_fk foreign key (proposal_id) references public.agent_proposals (id),
  add constraint messages_saved_reply_fk foreign key (saved_reply_id) references public.saved_replies (id);

create or replace function private.agent_proposal_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'proposal_not_pending: a proposal starts pending' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'proposal_not_pending: % proposals are final', old.status using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'message_id', 'updated_at'])
     <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'message_id', 'updated_at']) then
    raise exception 'proposal_immutable: only the decision can change' using errcode = '42501';
  end if;
  new.decided_at := coalesce(new.decided_at, now());
  return new;
end;
$$;

create trigger agent_proposals_rules before insert or update on public.agent_proposals
  for each row execute function private.agent_proposal_rules();
create trigger agent_proposals_touch before update on public.agent_proposals
  for each row execute function private.touch_updated_at();
create trigger audit_agent_proposals after insert or update or delete on public.agent_proposals
  for each row execute function private.audit_row_change();
create trigger events_agent_proposals after insert or update on public.agent_proposals
  for each row execute function private.emit_row_event('agent_proposal');

create trigger agent_proposals_never_deleted before delete on public.agent_proposals
  for each row execute function private.append_only();

-- ---------------------------------------------------------------------------
-- INB-02: an inquiry / unknown-sender conversation attaches when the booking is created
-- ---------------------------------------------------------------------------

create or replace function private.attach_conversation_to_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if new.kind <> 'guest' or new.guest_id is null then
    return null;
  end if;
  select g.email into v_email from public.guests g where g.id = new.guest_id;
  update public.conversations c
  set reservation_id = new.id, guest_id = new.guest_id
  where c.id = (
    select c2.id from public.conversations c2
    where c2.account_id = new.account_id
      and c2.reservation_id is null
      and (c2.guest_id = new.guest_id or (v_email is not null and c2.contact_email = v_email))
    order by c2.last_message_at desc nulls last, c2.created_at desc
    limit 1
  );
  return null;
end;
$$;

create trigger inbox_attach_conversation after insert on public.reservations
  for each row execute function private.attach_conversation_to_reservation();

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------

-- Loads a conversation the caller may read (inbox.view, and the reservation if it has one) and
-- checks the permission. Hides conversations the caller cannot see behind "not found".
create or replace function private.conversation_authorize(p_conversation_id uuid, p_permission text)
returns public.conversations
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.conversations;
begin
  select * into v from public.conversations where id = p_conversation_id;
  if not found or auth.uid() is null or not private.has_permission(v.account_id, 'inbox.view')
     or (v.reservation_id is not null and not exists (
           select 1 from public.reservations r
           where r.id = v.reservation_id and private.can_view_reservation(r.account_id, r.listing_id))) then
    raise exception 'conversation_not_found: %', p_conversation_id using errcode = 'P0002';
  end if;
  if not private.has_permission(v.account_id, p_permission) then
    raise exception 'forbidden: % on conversation', p_permission using errcode = '42501';
  end if;
  return v;
end;
$$;

-- The conversation of a reservation's guest, created if needed (concurrency-safe).
create or replace function private.reservation_conversation(p_r public.reservations)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.conversations;
  v_g public.guests;
  v_title text;
begin
  if p_r.kind <> 'guest' or p_r.guest_id is null then
    raise exception 'reservation_has_no_guest' using errcode = '22023';
  end if;
  select * into v from public.conversations where reservation_id = p_r.id and guest_id = p_r.guest_id;
  if found then
    return v;
  end if;
  select * into v_g from public.guests where id = p_r.guest_id;
  select coalesce(coalesce(p.public_title, p.internal_name), coalesce(l.public_title, l.internal_name)) into v_title
  from public.listings l left join public.listings p on p.id = l.parent_id where l.id = p_r.listing_id;
  insert into public.conversations (account_id, reservation_id, guest_id, contact_email, contact_name, subject)
  values (p_r.account_id, p_r.id, p_r.guest_id, v_g.email, btrim(concat_ws(' ', v_g.first_name, v_g.last_name)),
          left('Your stay at ' || coalesce(v_title, 'our place'), 300))
  on conflict (reservation_id, guest_id) where reservation_id is not null do nothing;
  select * into v from public.conversations where reservation_id = p_r.id and guest_id = p_r.guest_id;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- User RPCs
-- ---------------------------------------------------------------------------

-- Opens (or creates) the conversation of a reservation, e.g. from the reservation's Messages tab.
create or replace function public.inbox_open_conversation(p_reservation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.reservations := private.reservation_authorize(p_reservation_id, 'reservations.view');
begin
  if not private.has_permission(v_r.account_id, 'inbox.reply') then
    raise exception 'forbidden: inbox.reply' using errcode = '42501';
  end if;
  return (private.reservation_conversation(v_r)).id;
end;
$$;

-- INB-04 / INB-06 / INB-10: stores the reply (variables already resolved by the app server) and
-- queues its delivery, in one transaction. Optionally records which saved reply or AI draft it
-- came from; using a draft marks it accepted (unchanged) or edited.
create or replace function public.inbox_send_message(
  p_conversation_id uuid,
  p_body text,
  p_body_template text default null,
  p_saved_reply_id uuid default null,
  p_proposal_id uuid default null,
  p_channel text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id, 'inbox.reply');
  v_g public.guests;
  v_channel text := coalesce(p_channel, v_c.channel);
  v_to text;
  v_name text;
  v_id uuid;
  v_p public.agent_proposals;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception 'empty_message' using errcode = '22023';
  end if;
  if length(p_body) > 20000 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;
  if private.has_unresolved_variables(p_body) then
    raise exception 'unresolved_variables: %', (
      select string_agg(distinct m[1], ', ') from regexp_matches(p_body, '\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}', 'g') m
    ) using errcode = '22023';
  end if;
  if v_channel <> 'email' then
    raise exception 'channel_unavailable: %', v_channel using errcode = 'P0001';
  end if;
  if v_c.guest_id is not null then
    select * into v_g from public.guests where id = v_c.guest_id;
  end if;
  v_to := coalesce(v_c.contact_email, v_g.email);
  if v_to is null then
    raise exception 'no_recipient: the conversation has no email address' using errcode = 'P0001';
  end if;
  v_name := coalesce(nullif(btrim(concat_ws(' ', v_g.first_name, v_g.last_name)), ''), v_c.contact_name);
  if p_saved_reply_id is not null and not exists (select 1 from public.saved_replies s where s.id = p_saved_reply_id and s.account_id = v_c.account_id) then
    p_saved_reply_id := null;
  end if;
  if p_proposal_id is not null then
    select * into v_p from public.agent_proposals where id = p_proposal_id and conversation_id = v_c.id for update;
    if not found or v_p.status <> 'pending' then
      raise exception 'proposal_not_pending' using errcode = '55000';
    end if;
  end if;

  insert into public.messages (account_id, conversation_id, kind, channel, author_type, author_user_id, recipient_email, subject,
                               body, body_template, saved_reply_id, proposal_id)
  values (v_c.account_id, v_c.id, 'outbound', v_channel, 'user', auth.uid(), v_to, v_c.subject,
          p_body, nullif(p_body_template, p_body), p_saved_reply_id, p_proposal_id)
  returning id into v_id;

  insert into public.message_deliveries (message_id, account_id, channel, to_address, to_name)
  values (v_id, v_c.account_id, v_channel, v_to, v_name);

  if p_proposal_id is not null then
    update public.agent_proposals
    set status = case when btrim(content) = btrim(p_body) then 'accepted' else 'edited' end,
        decided_by = auth.uid(), message_id = v_id
    where id = p_proposal_id;
  end if;
  return v_id;
end;
$$;

-- INB-09 internal note; mentions are kept to active members of the account (notifications: X-06).
create or replace function public.inbox_add_note(p_conversation_id uuid, p_body text, p_mentions uuid[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id, 'inbox.reply');
  v_id uuid;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception 'empty_message' using errcode = '22023';
  end if;
  insert into public.messages (account_id, conversation_id, kind, channel, author_type, author_user_id, body, mentions)
  values (v_c.account_id, v_c.id, 'note', 'internal', 'user', auth.uid(), btrim(p_body),
          coalesce((select array_agg(distinct m.user_id) from public.memberships m
                    where m.account_id = v_c.account_id and m.status = 'active' and m.user_id = any (coalesce(p_mentions, '{}'))), '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

-- INB-08 done / reopen.
create or replace function public.inbox_set_status(p_conversation_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id, 'inbox.reply');
begin
  if p_status not in ('open', 'done') then
    raise exception 'invalid_status: %', p_status using errcode = '22023';
  end if;
  update public.conversations set status = p_status where id = v_c.id and status <> p_status;
end;
$$;

-- INB-08 assignment. Taking a conversation yourself needs inbox.reply; assigning others inbox.manage.
create or replace function public.inbox_assign(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id,
    case when p_user_id = auth.uid() then 'inbox.reply' else 'inbox.manage' end);
begin
  update public.conversations set assignee_user_id = p_user_id
  where id = v_c.id and assignee_user_id is distinct from p_user_id;
end;
$$;

create or replace function public.inbox_set_tags(p_conversation_id uuid, p_tags text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id, 'inbox.manage');
begin
  update public.conversations set tags = coalesce(p_tags, '{}') where id = v_c.id;
end;
$$;

create or replace function public.inbox_mark_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations := private.conversation_authorize(p_conversation_id, 'inbox.view');
begin
  insert into public.conversation_reads (conversation_id, user_id, account_id, last_read_at)
  values (v_c.id, auth.uid(), v_c.account_id, now())
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
end;
$$;

-- INB-10 retry a failed message (or discard it; business rule: never edited or deleted).
create or replace function public.inbox_retry_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
begin
  select * into v_m from public.messages where id = p_message_id;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  perform private.conversation_authorize(v_m.conversation_id, 'inbox.reply');
  update public.message_deliveries
  set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null
  where message_id = v_m.id;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.inbox_discard_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
begin
  select * into v_m from public.messages where id = p_message_id;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  perform private.conversation_authorize(v_m.conversation_id, 'inbox.reply');
  update public.message_deliveries set status = 'discarded' where message_id = v_m.id;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Dismiss an AI draft (accept/edit happen by sending it).
create or replace function public.reject_agent_proposal(p_proposal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.agent_proposals;
begin
  select * into v_p from public.agent_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found' using errcode = 'P0002';
  end if;
  perform private.conversation_authorize(v_p.conversation_id, 'inbox.reply');
  if v_p.status <> 'pending' then
    raise exception 'proposal_not_pending' using errcode = '55000';
  end if;
  update public.agent_proposals set status = 'rejected', decided_by = auth.uid() where id = v_p.id;
end;
$$;

-- INB-14 full-text search across messages the caller can read (security invoker: RLS applies).
create or replace function public.search_inbox(p_account_id uuid, p_query text, p_limit integer default 50)
returns table (conversation_id uuid, message_id uuid, snippet text, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select m.conversation_id, m.id,
         ts_headline('simple', m.body, q, 'StartSel=[[, StopSel=]], MaxWords=20, MinWords=6, MaxFragments=1'),
         m.created_at
  from public.messages m
  cross join websearch_to_tsquery('simple', coalesce(p_query, '')) q
  where m.account_id = p_account_id
    and length(btrim(coalesce(p_query, ''))) >= 2
    and m.search @@ q
  order by ts_rank(m.search, q) desc, m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ---------------------------------------------------------------------------
-- Service-role RPCs: inbound ingest, outbound queue, delivery events, agent proposals
-- ---------------------------------------------------------------------------

-- Threads an inbound email and stores it. Payload: see src/lib/inbox/email/ingest.ts. Matching
-- order: reply token → thread headers → guest email → contact email → new conversation.
-- Idempotent per (provider, provider message id).
create or replace function public.ingest_inbound_email(p_provider text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pmid text := nullif(btrim(p_payload ->> 'provider_message_id'), '');
  v_from text := nullif(lower(btrim(p_payload ->> 'from_email')), '');
  v_from_name text := nullif(btrim(p_payload ->> 'from_name'), '');
  v_reply text := nullif(lower(btrim(p_payload ->> 'reply_token')), '');
  v_subject text := left(nullif(btrim(p_payload ->> 'subject'), ''), 300);
  v_existing public.inbound_emails;
  v_account uuid;
  v_conv public.conversations;
  v_method text;
  v_guest public.guests;
  v_res public.reservations;
  v_thread text[];
  v_inbound uuid := gen_random_uuid();
  v_msg uuid := gen_random_uuid();
  v_to text[] := array(select jsonb_array_elements_text(coalesce(p_payload -> 'to', '[]'::jsonb)));
begin
  if v_pmid is null or v_from is null then
    raise exception 'invalid_inbound: provider_message_id and from_email are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('inbound:' || p_provider || ':' || v_pmid, 0));
  select * into v_existing from public.inbound_emails where provider = p_provider and provider_message_id = v_pmid;
  if found then
    return jsonb_build_object('inbound_email_id', v_existing.id, 'status', v_existing.status, 'match_method', v_existing.match_method,
                              'conversation_id', v_existing.conversation_id, 'message_id', v_existing.message_id, 'duplicate', true);
  end if;

  select s.account_id into v_account from public.inbox_settings s where s.inbound_token = lower(nullif(p_payload ->> 'account_token', ''));
  if v_reply is not null then
    select * into v_conv from public.conversations c where c.reply_token = v_reply and (v_account is null or c.account_id = v_account);
    if found then
      v_account := v_conv.account_id;
      v_method := case when p_payload ->> 'reply_token_source' = 'subject' then 'reply_token_subject' else 'reply_token_address' end;
    end if;
  end if;

  if v_account is null then
    insert into public.inbound_emails (id, account_id, provider, provider_message_id, from_email, from_name, to_addresses, subject,
                                       rfc_message_id, status, payload)
    values (v_inbound, null, p_provider, v_pmid, v_from, v_from_name, v_to, p_payload ->> 'raw_subject',
            p_payload ->> 'rfc_message_id', 'unmatched', p_payload);
    return jsonb_build_object('inbound_email_id', v_inbound, 'status', 'unmatched', 'match_method', null,
                              'conversation_id', null, 'message_id', null, 'duplicate', false);
  end if;

  -- One sender at a time per account, so concurrent emails do not open two conversations.
  perform pg_advisory_xact_lock(hashtextextended('inbound-sender:' || v_account::text || ':' || v_from, 0));

  if v_conv.id is null then
    v_thread := array(select jsonb_array_elements_text(coalesce(p_payload -> 'thread_ids', '[]'::jsonb)));
    if cardinality(v_thread) > 0 then
      select c.* into v_conv
      from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.account_id = v_account and m.rfc_message_id = any (v_thread)
      order by m.created_at desc limit 1;
      if found then
        v_method := 'thread_header';
      end if;
    end if;
  end if;

  if v_conv.id is null then
    select g.* into v_guest from public.guests g
    where g.account_id = v_account and g.email = v_from and g.merged_into_id is null
    order by g.created_at desc limit 1;
    if found then
      -- The guest's current or next stay, else the latest one.
      select r.* into v_res from public.reservations r join public.listings l on l.id = r.listing_id
      where r.guest_id = v_guest.id and r.kind = 'guest' and r.status in ('inquiry', 'reserved', 'confirmed')
        and r.check_out >= (now() at time zone l.timezone)::date
      order by r.check_in limit 1;
      if v_res.id is null then
        select r.* into v_res from public.reservations r where r.guest_id = v_guest.id and r.kind = 'guest' order by r.check_in desc limit 1;
      end if;
      if v_res.id is not null then
        v_conv := private.reservation_conversation(v_res);
      else
        select * into v_conv from public.conversations c
        where c.account_id = v_account and c.guest_id = v_guest.id and c.reservation_id is null
        order by c.last_message_at desc nulls last limit 1;
        if v_conv.id is null then
          insert into public.conversations (account_id, guest_id, contact_email, contact_name, subject)
          values (v_account, v_guest.id, v_from, coalesce(v_from_name, btrim(concat_ws(' ', v_guest.first_name, v_guest.last_name))), v_subject)
          returning * into v_conv;
        end if;
      end if;
      v_method := 'guest_email';
    end if;
  end if;

  if v_conv.id is null then
    select * into v_conv from public.conversations c
    where c.account_id = v_account and c.reservation_id is null and c.contact_email = v_from
    order by c.last_message_at desc nulls last limit 1;
    if found then
      v_method := 'contact_email';
    else
      insert into public.conversations (account_id, contact_email, contact_name, subject)
      values (v_account, v_from, v_from_name, v_subject)
      returning * into v_conv;
      v_method := 'new_conversation';
    end if;
  end if;

  insert into public.inbound_emails (id, account_id, provider, provider_message_id, from_email, from_name, to_addresses, subject,
                                     rfc_message_id, status, match_method, conversation_id, message_id, payload)
  values (v_inbound, v_account, p_provider, v_pmid, v_from, v_from_name, v_to, p_payload ->> 'raw_subject',
          p_payload ->> 'rfc_message_id', 'matched', v_method, v_conv.id, v_msg, p_payload);

  insert into public.messages (id, account_id, conversation_id, kind, channel, author_type, sender_name, sender_email, subject, body,
                               attachments, rfc_message_id, in_reply_to, inbound_email_id)
  values (v_msg, v_account, v_conv.id, 'inbound', 'email', 'guest', left(v_from_name, 200), v_from,
          left(p_payload ->> 'raw_subject', 1000),
          left(coalesce(nullif(btrim(p_payload ->> 'text'), ''), '(empty message)'), 20000),
          coalesce(p_payload -> 'attachments', '[]'::jsonb), left(p_payload ->> 'rfc_message_id', 1000),
          left(p_payload -> 'thread_ids' ->> 0, 1000), v_inbound);

  return jsonb_build_object('inbound_email_id', v_inbound, 'status', 'matched', 'match_method', v_method,
                            'conversation_id', v_conv.id, 'message_id', v_msg, 'duplicate', false);
end;
$$;

-- Claims due outbound messages with a lease (FOR UPDATE SKIP LOCKED); overlapping workers are safe.
create or replace function public.claim_outbound_messages(p_limit integer default 50, p_lease_seconds integer default 60, p_account_id uuid default null)
returns table (
  message_id uuid,
  account_id uuid,
  attempts integer,
  to_address text,
  to_name text,
  subject text,
  body text,
  rfc_message_id text,
  in_reply_to text,
  thread_references text[],
  reply_token text,
  account_token text,
  sender_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select d.message_id
    from public.message_deliveries d
    where (d.status = 'queued' or (d.status = 'sending' and d.locked_until < now()))
      and d.next_attempt_at <= now()
      and (p_account_id is null or d.account_id = p_account_id)
    order by d.next_attempt_at, d.message_id
    limit greatest(coalesce(p_limit, 50), 0)
    for update skip locked
  ),
  claimed as (
    update public.message_deliveries d
    set status = 'sending', attempts = d.attempts + 1, locked_until = now() + make_interval(secs => coalesce(p_lease_seconds, 60))
    from due
    where d.message_id = due.message_id
    returning d.message_id, d.account_id, d.attempts, d.to_address, d.to_name
  )
  select c.message_id, c.account_id, c.attempts, c.to_address, c.to_name, m.subject, m.body, m.rfc_message_id,
         (select p.rfc_message_id from public.messages p
          where p.conversation_id = m.conversation_id and p.kind = 'inbound' and p.rfc_message_id is not null and p.created_at <= m.created_at and p.id <> m.id
          order by p.created_at desc limit 1),
         coalesce(array(select x.rfc_message_id from (
            select p.rfc_message_id, p.created_at from public.messages p
            where p.conversation_id = m.conversation_id and p.kind in ('inbound', 'outbound') and p.rfc_message_id is not null
              and p.created_at <= m.created_at and p.id <> m.id
            order by p.created_at desc limit 10) x order by x.created_at), '{}'),
         cv.reply_token, s.inbound_token, coalesce(s.sender_name, a.name)
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.conversations cv on cv.id = m.conversation_id
  join public.accounts a on a.id = c.account_id
  join public.inbox_settings s on s.account_id = c.account_id;
end;
$$;

-- Records what the worker got from the provider. Ignored (false) unless the message is still
-- `sending` (another run may have taken it over after the lease expired).
create or replace function public.record_outbound_result(
  p_message_id uuid,
  p_outcome text,
  p_provider text default null,
  p_provider_message_id text default null,
  p_error text default null,
  p_retry_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.message_deliveries;
  v_status text;
begin
  if p_outcome not in ('sent', 'delivered', 'retry', 'failed') then
    raise exception 'invalid_outcome: %', p_outcome using errcode = '22023';
  end if;
  select * into v from public.message_deliveries where message_id = p_message_id for update;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  if v.status <> 'sending' then
    return false;
  end if;
  v_status := case p_outcome when 'retry' then case when p_retry_at is null then 'failed' else 'queued' end else p_outcome end;
  update public.message_deliveries
  set status = v_status,
      provider = coalesce(p_provider, provider),
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      last_error = case when v_status in ('sent', 'delivered') then null else left(coalesce(p_error, 'Unknown error'), 2000) end,
      next_attempt_at = case when v_status = 'queued' then p_retry_at else next_attempt_at end
  where message_id = p_message_id;
  return true;
end;
$$;

-- Provider delivery webhooks (delivered / bounced). Returns whether anything changed.
create or replace function public.record_delivery_event(p_provider text, p_provider_message_id text, p_status text, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.message_deliveries;
begin
  if p_status not in ('delivered', 'failed') then
    raise exception 'invalid_status: %', p_status using errcode = '22023';
  end if;
  select * into v from public.message_deliveries where provider = p_provider and provider_message_id = p_provider_message_id for update;
  if not found or not private.delivery_transition_allowed(v.status, p_status) or v.status = 'sending' then
    return false;
  end if;
  update public.message_deliveries
  set status = p_status, last_error = case when p_status = 'failed' then left(coalesce(p_reason, 'Bounced'), 2000) end
  where message_id = v.message_id;
  return true;
end;
$$;

-- INB-11: the agent stores a reply draft for a human to edit and send. Called by the app server
-- as the agent actor (service role + x-pms-actor-type: agent) after it checked the requesting
-- user's access. Never sends anything.
create or replace function public.agent_propose_reply(
  p_conversation_id uuid,
  p_content text,
  p_requested_by uuid,
  p_reasoning_summary text default null,
  p_confidence text default null,
  p_needs_human boolean default false,
  p_grounding jsonb default '{}'::jsonb,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_id uuid;
begin
  if not private.agent_has_permission('inbox.reply') then
    raise exception 'forbidden: only the agent proposes replies, and its role must allow inbox.reply' using errcode = '42501';
  end if;
  select * into v_c from public.conversations where id = p_conversation_id;
  if not found then
    raise exception 'conversation_not_found: %', p_conversation_id using errcode = 'P0002';
  end if;
  if not coalesce((select s.ai_drafts_enabled from public.inbox_settings s where s.account_id = v_c.account_id), false) then
    raise exception 'ai_drafts_disabled' using errcode = 'P0001';
  end if;
  if p_requested_by is null or not exists (
    select 1 from public.memberships m
    join public.role_permissions rp on rp.role = m.role and rp.permission = 'inbox.reply'
    where m.account_id = v_c.account_id and m.user_id = p_requested_by and m.status = 'active'
  ) then
    raise exception 'forbidden: the requesting user cannot reply in this account' using errcode = '42501';
  end if;
  if p_content is null or btrim(p_content) = '' then
    raise exception 'empty_message' using errcode = '22023';
  end if;

  update public.agent_proposals set status = 'superseded'
  where conversation_id = v_c.id and kind = 'reply_draft' and status = 'pending';

  insert into public.agent_proposals (account_id, kind, conversation_id, reservation_id, tool_name, tool_input, content,
                                      reasoning_summary, confidence, needs_human, grounding, model, input_tokens, output_tokens, requested_by)
  values (v_c.account_id, 'reply_draft', v_c.id, v_c.reservation_id, 'inbox_send_message',
          jsonb_build_object('p_conversation_id', v_c.id, 'p_body', p_content), p_content,
          left(p_reasoning_summary, 4000), p_confidence, coalesce(p_needs_human, false), coalesce(p_grounding, '{}'::jsonb),
          p_model, p_input_tokens, p_output_tokens, p_requested_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- INB-01 conversation list. Security invoker: the caller's RLS decides what appears.
create view public.inbox_conversation_list
with (security_invoker = true)
as
select c.id, c.account_id, c.reservation_id, c.guest_id, c.channel, c.status, c.assignee_user_id, c.tags, c.subject,
       c.awaiting_reply_since, c.last_message_at, c.last_message_preview, c.last_message_kind, c.last_guest_message_at,
       c.created_at, c.done_at,
       coalesce(nullif(btrim(concat_ws(' ', g.first_name, g.last_name)), ''), c.contact_name, c.contact_email) as guest_name,
       coalesce(c.contact_email, g.email) as guest_email,
       g.language as guest_language,
       r.code as reservation_code, r.status as reservation_status, r.stay_status, r.check_in, r.check_out, r.source,
       l.id as listing_id, l.internal_name as listing_name, l.timezone as listing_timezone,
       coalesce(l.tags, '{}') || coalesce(lp.tags, '{}') as listing_tags,
       lp.id as parent_listing_id,
       p.full_name as assignee_name, p.email as assignee_email,
       (c.last_guest_message_at is not null and c.last_guest_message_at > coalesce(rd.last_read_at, '-infinity'::timestamptz)) as unread,
       coalesce(r.status in ('reserved', 'confirmed')
                and r.check_in between (now() at time zone l.timezone)::date and (now() at time zone l.timezone)::date + 2, false) as arriving_soon
from public.conversations c
left join public.reservations r on r.id = c.reservation_id
left join public.guests g on g.id = c.guest_id
left join public.listings l on l.id = r.listing_id
left join public.listings lp on lp.id = l.parent_id
left join public.profiles p on p.user_id = c.assignee_user_id
left join public.conversation_reads rd on rd.conversation_id = c.id and rd.user_id = (select auth.uid());

-- INB-13 response time per user (last 90 days) and per conversation.
create view public.inbox_response_stats
with (security_invoker = true)
as
select m.account_id, m.author_user_id, p.full_name, p.email,
       count(*)::integer as replies,
       round(avg(m.response_seconds))::integer as avg_seconds,
       (percentile_cont(0.5) within group (order by m.response_seconds))::integer as median_seconds
from public.messages m
left join public.profiles p on p.user_id = m.author_user_id
where m.kind = 'outbound' and m.response_seconds is not null and m.created_at > now() - interval '90 days'
group by m.account_id, m.author_user_id, p.full_name, p.email;

create view public.inbox_conversation_response
with (security_invoker = true)
as
select m.conversation_id, m.account_id,
       count(*)::integer as replies,
       round(avg(m.response_seconds))::integer as avg_seconds,
       (array_agg(m.response_seconds order by m.created_at))[1] as first_response_seconds
from public.messages m
where m.kind = 'outbound' and m.response_seconds is not null
group by m.conversation_id, m.account_id;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.inbox_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_deliveries enable row level security;
alter table public.inbound_emails enable row level security;
alter table public.saved_replies enable row level security;
alter table public.conversation_reads enable row level security;
alter table public.agent_proposals enable row level security;

revoke all on public.inbox_settings, public.conversations, public.messages, public.message_deliveries, public.inbound_emails,
  public.saved_replies, public.conversation_reads, public.agent_proposals,
  public.inbox_conversation_list, public.inbox_response_stats, public.inbox_conversation_response from anon;
revoke insert, update, delete, truncate on public.inbox_settings, public.conversations, public.messages, public.message_deliveries,
  public.inbound_emails, public.conversation_reads, public.agent_proposals from authenticated;
revoke delete, truncate on public.saved_replies from authenticated;
grant update (sender_name, ai_drafts_enabled) on public.inbox_settings to authenticated;
grant select on public.inbox_conversation_list, public.inbox_response_stats, public.inbox_conversation_response to authenticated;

create policy inbox_settings_select on public.inbox_settings for select to authenticated
  using (private.has_permission(account_id, 'inbox.view'));
create policy inbox_settings_update on public.inbox_settings for update to authenticated
  using (private.has_permission(account_id, 'inbox.manage'))
  with check (private.has_permission(account_id, 'inbox.manage'));

create policy conversations_select on public.conversations for select to authenticated
  using (private.has_permission(account_id, 'inbox.view')
         and (reservation_id is null or exists (select 1 from public.reservations r where r.id = reservation_id)));

create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));

create policy message_deliveries_select on public.message_deliveries for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id));

create policy inbound_emails_select on public.inbound_emails for select to authenticated
  using (account_id is not null and private.has_permission(account_id, 'inbox.manage'));

create policy saved_replies_select on public.saved_replies for select to authenticated
  using (private.has_permission(account_id, 'inbox.view'));
create policy saved_replies_insert on public.saved_replies for insert to authenticated
  with check (private.has_permission(account_id, 'inbox.manage'));
create policy saved_replies_update on public.saved_replies for update to authenticated
  using (private.has_permission(account_id, 'inbox.manage'))
  with check (private.has_permission(account_id, 'inbox.manage'));

create policy conversation_reads_select on public.conversation_reads for select to authenticated
  using (user_id = (select auth.uid()));

create policy agent_proposals_select on public.agent_proposals for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.inbox_open_conversation(uuid)',
    'public.inbox_send_message(uuid, text, text, uuid, uuid, text)',
    'public.inbox_add_note(uuid, text, uuid[])',
    'public.inbox_set_status(uuid, text)',
    'public.inbox_assign(uuid, uuid)',
    'public.inbox_set_tags(uuid, text[])',
    'public.inbox_mark_read(uuid)',
    'public.inbox_retry_message(uuid)',
    'public.inbox_discard_message(uuid)',
    'public.reject_agent_proposal(uuid)',
    'public.search_inbox(uuid, text, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.ingest_inbound_email(text, jsonb)',
    'public.claim_outbound_messages(integer, integer, uuid)',
    'public.record_outbound_result(uuid, text, text, text, text, timestamptz)',
    'public.record_delivery_event(text, text, text, text)',
    'public.agent_propose_reply(uuid, text, uuid, text, text, boolean, jsonb, text, integer, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- INB-15: new messages and status changes reach open inboxes through Supabase Realtime (RLS applies).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.conversations, public.messages, public.message_deliveries, public.agent_proposals';
  end if;
end;
$$;

revoke execute on all functions in schema private from public;
