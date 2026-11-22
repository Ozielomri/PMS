# Step 6 — Unified Inbox (email first, AI-first foundations)

Scope: INB-01 … INB-10, INB-13 … INB-16 (P0 + listed P1) and INB-11 (AI reply drafts, never auto-sent), plus the AI-agent
foundations of `docs/plans/ai-agent.md` (actor type `agent`, role `agent`, approval queue). Channel: email. Booking.com
messages plug into the same `channel` column in step 9. INB-12 (auto-translate, P2) is out of scope.

## Data model (migrations `20261125001xxx`)

| Table | Purpose |
| --- | --- |
| `inbox_settings` | One row per account: inbound address token (`<token>@INBOX_INBOUND_DOMAIN`), sender name, AI drafts switch (agent kill switch) |
| `conversations` | One per guest per reservation (INB-02). `reservation_id` null = inquiry/unknown sender; attaches when a booking for that guest (id or email) is created. Status `open`/`done`, assignee, tags, `awaiting_reply_since`, last message summary, `reply_token` |
| `messages` | Inbound, outbound and internal notes. **Append-only** (no update/delete; trigger). Channel per message, author (user/agent/guest/system), body, the template it came from, saved reply / AI proposal used, RFC Message-ID for threading, `response_seconds` (INB-13), full-text `search` column (INB-14), `mentions` for notes (INB-09) |
| `message_deliveries` | Delivery state of each outbound message (INB-10): queued → sending → sent → delivered, failed (with reason) → queued (retry) or discarded. Status machine in a trigger, mirrored in `src/lib/inbox/delivery.ts`. Worker lease + attempts + backoff |
| `inbound_emails` | Raw log of every inbound email (idempotent on provider + provider message id), with match result. Rows whose account cannot be identified keep `account_id` null (service role only) |
| `saved_replies` | INB-05 library: title, shortcut, body with variables, language variants (`variants` jsonb `{lang: body}`) |
| `conversation_reads` | Per-user read marker (INB-01 unread); not audited (UI state like saved views) |
| `agent_proposals` | Approval queue (ai-agent plan): kind (`reply_draft` first), status (pending → accepted / edited / rejected / superseded), the exact proposed tool call, content, reasoning summary, model and token usage, who asked, who decided |

Roles: new enum value `agent` (own migration, `20261125001000`, because a new enum value cannot be used in the transaction
that adds it). Memberships and invitations refuse `agent`: the agent is not a person. `private.agent_has_permission()` reads
the same `role_permissions` rows. Agent permissions: `account.view`, `properties.view`, `calendar.view`, `reservations.view`,
`reservations.view_next_guest`, `inbox.view`, `inbox.reply` (no money, no edits, no cancels). Actor type `agent` is accepted
by `private.current_actor()` from the service role and by the audit log / event envelope.

## Rules and where they live

* **Threading / matching (SQL `public.ingest_inbound_email`, service role).** In order: reply token in a recipient address
  (`<account>+<reply token>@domain`) → reply token in the subject (`[#token]`) → `In-Reply-To` / `References` matching a stored
  Message-ID → sender email of a guest of the account (their current/next reservation's conversation, created if needed) →
  sender's latest open contact conversation → new contact-only conversation. Unknown account address → stored unmatched.
  Idempotent on (provider, provider message id) with an advisory lock. Token extraction and quoted-text stripping happen in
  TypeScript (`src/lib/inbox/email/parse.ts`, unit-tested); SQL validates tokens against the account.
* **Attach later (INB-02).** A trigger on `reservations` insert attaches the newest contact-only conversation of the same
  guest (by guest id or email); an inquiry that becomes a booking keeps its reservation id, so its conversation stays.
* **Done / reopen (INB-08).** A new guest message on a Done conversation reopens it (trigger on message insert).
* **Variables (INB-06).** `src/lib/inbox/variables.ts` builds `guest.*`, `reservation.*`, `account.*` and, through the
  existing `resolveListingVariables()`, `listing.*` / `custom.*` (secret fields decrypted on the server only). Empty or unknown
  variables are *unresolved* and block sending; the composer previews the resolved text. The database refuses any outbound
  body that still contains a `{{…}}` placeholder (check constraint), so the rule holds even if the app is bypassed.
* **Sending (INB-10).** `public.inbox_send_message()` (user, `inbox.reply`) stores the resolved message and a `queued`
  delivery in one transaction. The worker `POST /api/internal/inbox/send` claims deliveries (`FOR UPDATE SKIP LOCKED` + lease),
  sends through the email adapter and records the result; failures retry with `src/lib/retry` backoff, then fail with the
  reason. Failed messages can be retried or discarded by a user. After a send the server action also kicks the worker for that
  account (`after()`), so messages leave without waiting for the schedule.
* **Email adapter (`src/lib/inbox/email/`).** `EmailProvider` interface: `send()`, `parseInbound()`, `parseEvent()`.
  `postmark` (HTTP API via `fetch`, inbound JSON, delivery/bounce webhooks) and `log` (dev: logs and reports *delivered*; used
  whenever `POSTMARK_SERVER_TOKEN` is missing). Inbound route `POST /api/internal/inbox/email/inbound` and delivery events
  `POST /api/internal/inbox/email/events` accept `Authorization: Bearer|Basic` with `INBOX_WEBHOOK_SECRET` or an
  `X-PMS-Signature` HMAC over the body with the same secret.
* **Events (INB-16).** `message.received` (inbound insert), `message.queued`, `message.sent`, `message.failed`,
  `message.note_added`, `conversation.created` / `conversation.updated`, `agent_proposal.created` / `.updated`; all from SQL in
  the same transaction. Audit triggers on every table except `conversation_reads`.
* **Realtime (INB-15).** `messages`, `conversations` and `message_deliveries` join the `supabase_realtime` publication
  (guarded); the inbox subscribes and refreshes. Browser/mobile push is a follow-up (needs a service worker + VAPID keys).
* **Response time (INB-13).** On the first outbound reply after a guest message, `response_seconds` is stored on the reply
  (before insert, so the row stays immutable). View `inbox_response_stats` averages per conversation and per user.
* **Search (INB-14).** `messages.search` (`tsvector`, `simple` config, GIN) + `public.search_inbox()` (security invoker).
* **AI drafts (INB-11).** `src/lib/ai/` holds an `LlmProvider` interface and the Anthropic implementation (official SDK,
  `ANTHROPIC_API_KEY`, model `ANTHROPIC_MODEL` default `claude-opus-5-5`, server-side refusal fallback). `draftReply()` grounds
  the prompt in the thread, the reservation (no money, no contact details), the listing's descriptions/house rules/amenities and
  **non-secret** custom fields. The result is stored as an `agent_proposals` row by the agent actor
  (`public.agent_propose_reply`, service role, checks the agent role and the account switch) and shown in the composer. A
  human edits and sends; the proposal is marked accepted/edited. Nothing is ever sent by the agent in this step. Without the
  key the button is disabled with an explanation. Tests mock the provider.

## Permissions

| Action | Permission |
| --- | --- |
| Read conversations, messages, mark read | `inbox.view` (+ reservation visibility for reservation conversations) |
| Send, add note, done/reopen, retry/discard, suggest reply | `inbox.reply` |
| Assign / reassign, saved replies, tags, message log, inbound log | `inbox.manage` |

## Screens

1. `/inbox` — three columns (list · thread + composer · context panel), two on tablet, stacked on mobile (the selected
   conversation replaces the list, with a back link). Tabs: Unanswered, Assigned to me, Pending approval, Arriving in 48 h,
   In house, Done, All; filters: channel, listing, tag, search.
2. `/inbox/saved-replies` — list + editor with variable picker, language variants and preview against a sample reservation.
3. `/inbox/log` — admin message log: outbound deliveries with status/reason/retry, inbound log with match result, response
   times per user.
4. Reservation page → Messages tab shows the thread and composer.

## Tests

* Unit: inbound parsing (addresses, tokens, quoted text, Postmark payload), variable resolution and the unresolved rule,
  delivery state machine mirror, outbox worker (retry/backoff/fail/delivered), webhook auth, AI draft prompt building and
  output parsing with a mocked provider, Postmark adapter with mocked `fetch`.
* DB: matching order and idempotency, unmatched storage and attach-later, done → reopen, append-only messages, the
  `{{…}}` guard, delivery transitions (parity with TS), claim/lease/record, permissions per role, agent role and actor,
  proposals, events, response time, search, RLS/tenancy.
* E2E: smoke for `/inbox`, `/inbox/saved-replies`, `/inbox/log` redirect to sign-in; inbound route rejects unsigned calls.
