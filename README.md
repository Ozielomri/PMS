# PMS

Property management system for short-term rentals — technical trial. Requirements: [`docs/requirements.md`](docs/requirements.md). Project rules and build order: [`CLAUDE.md`](CLAUDE.md).

**Status:** step 1 (foundations: X-01 to X-04) is built. See [`docs/plans/step-1-foundations.md`](docs/plans/step-1-foundations.md) for the design and the interpretation calls.

## Stack

Next.js 16 (App Router, Cache Components, `src/proxy.ts`) · Supabase (Postgres, Auth, RLS, Realtime) · Vitest · Playwright. Deploys to Vercel.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the values
```

Local Supabase (Docker):

```bash
npx supabase start           # applies supabase/migrations, prints URL + keys
```

```bash
npm run dev
```

Open http://localhost:3000, create an account, set up your company, then enrol TOTP (admins must use it). Local email (magic links, confirmations) is in Mailpit at http://127.0.0.1:54324.

Hosted Supabase: create the project in a **US region** (X-10), turn on TOTP under Authentication → MFA, set the site URL and add `<site>/auth/confirm` as a redirect URL, then `npx supabase link` and `npx supabase db push`.

## Tests

| Command | What | Needs |
| --- | --- | --- |
| `npm run test:unit` | Pure TS: permissions, MFA gate, HMAC, backoff, SSRF guard, crypto, dispatcher, bus | nothing |
| `npm run test:db` | Migrations + RLS + triggers + workers on a fresh `pms_test` database | Postgres 16+ superuser at `TEST_DATABASE_URL` |
| `npm run test:e2e` | Playwright smoke tests against `next start` | Chromium (`npx playwright install chromium`, or `PW_CHROMIUM_PATH=/path/to/chrome`) |
| `E2E_SUPABASE=1 npm run test:e2e` | + full sign-up → TOTP → invite flow | `supabase start` and the Supabase env vars |

The DB suite runs on plain Postgres: `tests/db/supabase-shim.sql` adds the few Supabase pieces the migrations use (`auth.uid()`, `auth.jwt()`, API roles, default grants). On a real Supabase database the shim is skipped.

## Background workers

Idempotent endpoints, protected by `Authorization: Bearer $CRON_SECRET`; overlapping runs are safe:

- `POST /api/internal/webhooks/dispatch` sends due webhook deliveries
- `POST /api/internal/events/process` runs internal event consumers (none registered until automations, step 7)
- `POST /api/internal/automations/run` runs due automation jobs (step 7)
- `POST /api/internal/reservations/expire` expires requests past their approval deadline, closes past inquiries and expires quotes (the reservation list, dashboard and quotes page also sweep their own account on load)
- `POST /api/internal/ical/sync` imports due iCal feeds (CAL-10; schedule every 15 minutes)
- `POST /api/internal/inbox/send` sends queued guest messages with retries and backoff (sending a reply also kicks it for that account, so replies go out without the schedule)

**Vercel Schedules** call both every minute once the project is on the **Pro plan** (Hobby allows at most every 15 minutes). They are currently **off**: see [`TODO.md`](TODO.md). Set `CRON_SECRET` in the project's environment variables; Vercel sends it as the bearer token. Schedules run against the production deployment only; locally, call an endpoint by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/internal/webhooks/dispatch
```

## Properties (step 3)

Listings, multi-units, content, photos, custom fields and the change log: [`docs/plans/step-3-properties.md`](docs/plans/step-3-properties.md). Screens under `/properties` (list with filters and bulk edit, create wizard, tabbed editor with autosave, multi-unit view, custom fields, CSV export).

- **Photos** go to the Supabase Storage bucket `listing-photos` (created by migration `20261122002100`, public read, 25 MB, JPEG/PNG/HEIC). Resized variants come from **Supabase image transformations** (Pro plan): set `NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS=on` once they are enabled. Until then the original files are shown (the render endpoint answers 403 on the free plan).
- **Secret custom fields** (door codes) are encrypted with `PMS_ENCRYPTION_KEY` before they reach the database; `resolveListingVariables()` in `src/lib/properties/variables.ts` turns listing values into `{{custom.*}}` / `{{listing.*}}` message variables for the Inbox.
- Activation, archive, timezone and multi-unit rules are enforced in the database; a listing can only be `active` with address, timezone, capacity, base price, check-in/out times and a photo.

## Reservations and calendar screens (step 4)

Plan: [`docs/plans/step-4-reservations.md`](docs/plans/step-4-reservations.md). The status machine, money, refunds, channel ingest and quotes live in the database (migrations `20261123001000`–`20261123002200`); the screens call those RPCs.

- `/calendar`: multi-calendar. Drag across nights for a menu (reservation, quote, owner stay, block/unblock, price and minimum nights); click a booking for its summary; drag a direct booking to another row or dates to move it (preview first). Multi-units show free units; their bookings sit on the unit rows. `/calendar/[listingId]` is the month view, `/calendar/bulk` the bulk editor with preview.
- `/reservations`: quick tabs, filters, saved views, CSV export. Detail page with status actions, alterations (preview → confirm), cancellation with refund preview, unit reassignment, extras/adjustments, payments, notes, private files (bucket `reservation-files`) and the activity log.
- `/reservations/quotes`: quotes with up to 10 options; the guest opens `/q/<token>` (public) and books one option at the quoted price.
- `/search` and the top-bar box search codes, guests, emails, phones and listings. `/settings/reservations` sets the approval window per source.

## iCal (step 5)

Plan: [`docs/plans/step-5-ical.md`](docs/plans/step-5-ical.md); migration `20261124001000_ical.sql`; code in `src/lib/ical/`. Settings in the listing editor's **iCal** tab (`calendar.manage`).

- **Export (CAL-09):** `GET /ical/<token>.ics`, public and availability only ("Not available" all-day events, no guest data). Only the token's sha256 is used for lookups; the token is also stored encrypted with `PMS_ENCRYPTION_KEY` so the editor can show the URL again. Rotate or revoke from the tab.
- **Import (CAL-10):** feed URLs are stored encrypted; the worker (`/api/internal/ical/sync`) or **Sync now** fetches them (https and public hosts only, 15 s, 5 MB, conditional GET), and the database diffs the events into `ical` holds. Overlaps with bookings are shown on the feed, never resolved by deleting anything. Locally, `WEBHOOKS_ALLOW_PRIVATE_NETWORKS=1` also allows http and private hosts for feeds.

## Inbox (step 6)

Plan: [`docs/plans/step-6-inbox.md`](docs/plans/step-6-inbox.md). Migrations `20261125001000`–`20261125001200`.

- `/inbox`: three columns (conversation list · thread and composer · context panel), two on tablet, stacked on mobile. Tabs Unanswered, Assigned to me, Unassigned, Pending approval, Arriving in 48 h, In house, Done, All; filters by channel, listing and tag; full-text search across messages. New messages appear live (Supabase Realtime).
- Composer: reply by email or add an internal note (with @mentions); saved replies via `/shortcut` or the picker; variables (`{{guest.first_name}}`, `{{reservation.check_in}}`, `{{listing.title}}`, `{{custom.door_code}}`, …) with a live preview of the resolved text. A reply with an unresolved or empty variable cannot be sent (the database refuses it too). Delivery status per message: queued, sent, delivered, failed with the reason; retry or discard.
- Context panel: reservation with approve / decline, guest and stay history, listing times, address and custom fields (secret ones decrypted on the server for people who can reply), response time, tags.
- `/inbox/saved-replies`: saved replies with variables and language variants, preview against a sample reservation. `/inbox/log`: outbound deliveries, inbound emails and how each was matched, response time per user, the inbound address, sender name and the AI switch.
- The reservation page's **Messages** tab shows the same thread and composer.
- **Threading:** one conversation per guest per reservation. Inbound email is matched by the reply token in the address (`<account token>+<reply token>@INBOX_INBOUND_DOMAIN`) or the subject (`[#token]`), then by `In-Reply-To` / `References`, then by the sender's email (a known guest goes to their current or next reservation); otherwise it starts a conversation without a reservation that attaches when a booking for that email is created. Mail for an unknown address is stored unmatched. Messages are never edited or deleted.
- **Email adapter** (`src/lib/inbox/email/`): Postmark (`POSTMARK_SERVER_TOKEN`), or the development `log` adapter when no token is set. With `log` nothing leaves the server, messages are marked delivered, and the context panel offers **Simulate guest reply** (it runs the real inbound matching). Inbound webhook `POST /api/internal/inbox/email/inbound`, delivery/bounce webhook `POST /api/internal/inbox/email/events`, both authorized with `INBOX_WEBHOOK_SECRET` (Basic auth password, Bearer, or an `X-PMS-Signature` HMAC of the body). The log adapter accepts a generic JSON body, so you can try it with curl (the account's inbound address is on `/inbox/log`):

  ```bash
  curl -X POST -H "Authorization: Bearer $INBOX_WEBHOOK_SECRET" -H 'content-type: application/json' \
    -d '{"message_id":"t1","from":"Ada <ada@example.com>","to":["TOKEN@in.example.com"],"subject":"Hi","text":"Is parking free?"}' \
    http://localhost:3000/api/internal/inbox/email/inbound
  ```

- **AI drafts (INB-11, AI-first):** "Suggest reply" asks the agent (role `agent`, actor type `agent`; see [`docs/plans/ai-agent.md`](docs/plans/ai-agent.md)) for a draft grounded in the thread, the reservation and the listing's content and non-secret custom fields. The draft is stored in the approval queue (`agent_proposals`) and shown in the composer; a person edits and sends it. Nothing is sent automatically. Needs `ANTHROPIC_API_KEY` and `SUPABASE_SECRET_KEY`; without them the button is disabled with the reason. Switch it off per account on `/inbox/log`.
- **Events:** `message.received`, `message.queued`, `message.sent`, `message.delivered`, `message.failed`, `message.discarded`, `message.note_added`, `conversation.created/updated`, `saved_reply.*`, `inbox_settings.updated`, `agent_proposal.*`.

## Automations (step 7)

Plan: [`docs/plans/step-7-automations.md`](docs/plans/step-7-automations.md); migration `20261126001000_automations.sql`; code in `src/lib/automations/`.

- `/automations`: rules (trigger + offset + optional fixed local time + conditions → action) and one-click common rules (confirmation, check-in instructions, mid-stay check, check-out reminder, review request). `/automations/new` and `/automations/<id>`: the builder with language variants, a variable picker, a preview against a sample reservation, a count of matching reservations and "send a test to myself". `/automations/log`: every run.
- Scheduling is in the database: a trigger on `reservations` re-evaluates the account's rules on every change (dates, ETA/ETD, listing, status, guests), so jobs move, appear or are canceled in the same transaction; activating, editing, pausing or deleting a rule reschedules its pending jobs. Check-in/out anchors use ETA/ETD or the listing's default times, in the listing timezone. One job per rule × reservation × occurrence (idempotent).
- Actions: a message to the guest (into the reservation's conversation, sent by the inbox outbox), an email to a fixed address (owner, cleaner), or "ask the AI agent" to draft a message into the approval queue (needs `ANTHROPIC_API_KEY`). Missing variable values fail the run visibly instead of sending a broken message.
- Worker: `POST /api/internal/automations/run` (cron secret), scheduled every 15 minutes on Hobby; every minute on Pro (TODO.md). Each reservation's **Automations** tab shows its runs with skip, send now and edit-this-message.

## Layout

```
supabase/migrations/   SQL: helpers + audit (000100), events (000200), accounts/roles (000300), webhooks (000400), realtime/cron (000500), listings core (20261122000100), properties (20261122002xxx)
src/lib/auth/          permissions matrix, MFA gate, auth context (DAL), safe redirects
src/lib/events/        event catalog, envelope type, internal bus worker
src/lib/webhooks/      dispatcher, HMAC signatures, SSRF guard, Supabase RPC stores
src/lib/crypto/        AES-256-GCM field encryption
src/lib/properties/    listing constants, form schemas, photos, secrets, message variables, CSV export
src/lib/inbox/         message variables, delivery status machine, email adapter (Postmark / log), outbox worker, filters
src/lib/ai/            LLM provider interface, Anthropic implementation, reply drafts
src/app/               pages: login, signup, mfa, onboarding, invite, dashboard, settings (team, webhooks, audit)
tests/unit|db|e2e/     Vitest unit, Vitest + Postgres, Playwright
```

## Calendar engine (step 2)

Design: [`docs/plans/step-2-calendar.md`](docs/plans/step-2-calendar.md). SQL API in `supabase/migrations/20261122001000_calendar_core.sql`, typed wrappers in `src/lib/calendar/service.ts`.

- `GET /api/calendar/availability` and `GET /api/calendar/quote`: signed-in users (permissions checked in SQL).
- `POST /api/calendar/machine/pricing-tool`: external pricing tools, `Authorization: Bearer pmspt_…` (create a token with `public.create_pricing_tool_token`, `calendar.manage`).
- `/api/calendar/machine/maintenance`: hourly Vercel Schedule (`CRON_SECRET`), keeps 730+ days generated and expires overdue holds.
