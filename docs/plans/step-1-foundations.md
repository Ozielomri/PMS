# Step 1 — Foundations (X-01 … X-04)

Status: built 21 Nov 2026. This file records the plan and the interpretation calls made, so they can be reviewed.

## Scope

| ID | What ships in this step |
| --- | --- |
| X-01 | Accounts, memberships, five roles, permission matrix (DB + TS, kept in sync by a test), listing scope (all / restricted to tags or listings), RLS helpers every later table uses |
| X-02 | Supabase Auth: email + password, magic link, TOTP 2FA; TOTP mandatory for Admin (enforced in the app *and* in the database via the `aal2` JWT claim). SSO is P2, not built |
| X-03 | Generic audit trigger on every audited table: actor (user, automation, channel, api, system), entity, diff, UTC timestamp, IP; append-only; secret columns redacted; 2-year purge function |
| X-04 | Transactional outbox `domain_events`; fan-out to internal consumers (`event_queue`) and to outbound webhooks (`webhook_deliveries`); TS bus worker; webhook dispatcher with HMAC-SHA256 signature, exponential backoff for 24 h, delivery log, redeliver; Realtime publication for the UI |

Not in this step: Booking.com access check (step 0), listings (step 3), teams for supervisors (step 8), public REST API (X-05), notifications centre (X-06).

## Architecture

```
Browser ──► Next.js (Vercel) ──► Supabase (PostgREST + Auth + Realtime)
              │  user JWT → RLS enforced          │
              │  service role → workers only      ▼
              │                          Postgres: tables + RLS + triggers
              ▼                                   │ same transaction
  /api/internal/webhooks/dispatch  ◄── claim ── webhook_deliveries
  /api/internal/events/process     ◄── claim ── event_queue
```

* **Database is the guard.** Every table has RLS scoped to `account_id`. Permission checks live in SQL (`private.has_permission`), so a bug in the app cannot widen access.
* **Events are emitted in SQL**, in the same transaction as the state change (outbox). A statement-level trigger fans each event out to matching consumers and webhook endpoints, so nothing is lost if a worker is down, and there is no cursor gap problem.
* **Workers** are idempotent route handlers protected by `CRON_SECRET`; they claim rows with `FOR UPDATE SKIP LOCKED` and a lease, so several can run in parallel.
* Helper functions live in a `private` schema that PostgREST does not expose.

## Data model (public schema unless noted)

| Table | Purpose |
| --- | --- |
| `accounts` | Operator account (timezone, currency USD) |
| `profiles` | Display copy of `auth.users` (name, email) |
| `memberships` | user × account × role × status (`active`, `suspended`, `removed` — never deleted) × `listing_scope` (`all`, `restricted`) |
| `membership_listing_scopes` | rows of (`tag`, value) or (`listing`, id) for restricted members |
| `invitations` | email + role + hashed token, expiry 7 days |
| `role_permissions` | reference matrix role → permission |
| `audit_log` | append-only audit trail |
| `domain_events` | outbox / event store |
| `event_consumers`, `event_queue` | internal bus subscribers and their per-event work items |
| `webhook_endpoints`, `webhook_deliveries`, `webhook_delivery_attempts` | outbound webhooks and delivery log |

## Permission matrix — interpretation

The requirements table uses words (Full / Edit / View / …). They are mapped to concrete permission keys in `src/lib/auth/permissions.ts` and seeded into `role_permissions`. Interpretation calls to review:

* **Full vs Edit:** *Full* adds create / archive / delete-like actions and module settings; *Edit* changes existing records. So a Manager edits listings but only an Admin creates or archives them.
* **Front office calendar "Block only":** `calendar.view` + `calendar.block`, no price/rule edits.
* **Front office reservations "Create, edit, no cancel":** includes viewing money.
* **Supervisor tasks "Full on own team":** gets the task permissions now; the *own team* restriction arrives with groups in step 8.
* **Cleaner:** only `*_own` / `*_assigned` / `next_guest` permissions; row-level filtering arrives with tasks.
* **Account administration** (users, settings, audit log, webhooks) is Admin only.
* **Admin without 2FA:** an Admin session at `aal1` has *no* effective permissions until TOTP is verified. The app sends them to `/mfa`.

## Actor and IP capture (audit)

* Authenticated requests → actor `user` = `auth.uid()`.
* Service-role requests (workers, channel sync, API) → actor from the `x-pms-actor-type` / `x-pms-actor-id` request headers, or from `pms.actor_type` / `pms.actor_id` settings inside a DB function; default `system`. These headers are ignored for non-service roles.
* IP → `x-pms-client-ip` header (set by our server-side Supabase client from the incoming request) falling back to `x-forwarded-for`. For direct API calls with a user JWT the value is client-supplied; recorded as-is.

## Webhooks

* Signature header `X-PMS-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; receivers should reject timestamps older than 5 minutes.
* Retry schedule: 30 s × 2^(n−1), capped at 1 h, ±20 % jitter; a delivery not succeeded within 24 h of creation is marked `failed`.
* Secrets: `whsec_…`, shown once, stored AES-256-GCM encrypted with `PMS_ENCRYPTION_KEY` (X-15 field-level encryption).
* SSRF guard: HTTPS only, no private / loopback / link-local targets (checked on create and on each send after DNS resolution).

## Tests

* **Unit (Vitest):** permission matrix, MFA gate, HMAC sign/verify, backoff, URL guard, AES-GCM, event pattern matching, safe redirects.
* **Database (Vitest + Postgres 16):** migrations applied to a fresh database on top of a small Supabase shim (`tests/db/supabase-shim.sql`: `auth` schema, `auth.uid()`, `auth.jwt()`, `anon` / `authenticated` / `service_role`). Covers tenant isolation, role permissions incl. `aal2`, listing scope, invitations, last-admin guard, audit diffs/actor/IP/redaction/immutability, event fan-out, concurrent claim with SKIP LOCKED, webhook dispatch against a local HTTP receiver (signature, retry, 24 h give-up).
* **E2E (Playwright):** smoke tests of the public auth pages. A full sign-up → MFA → invite flow needs a running Supabase stack (`supabase start`, Docker); it is written but skipped unless `E2E_SUPABASE=1`.

## Verification (21 Nov 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint`, `next build` | pass |
| `npm run test:unit` | 134 tests pass |
| `npm run test:db` (Postgres 16 + shim) | 62 tests pass |
| `npm run test:e2e` smoke | 13 pass |
| `E2E_SUPABASE=1` full flow (sign-up → TOTP → invite → cleaner) | **not run**: needs `supabase start` (Docker images could not be pulled in the build sandbox). Run it locally before step 2. |

Found and fixed during testing: functions in `private` were executable by `authenticated` (Postgres grants EXECUTE to PUBLIC and per-schema default privileges cannot remove it), which would have let a signed-in user forge domain events. Every migration now revokes them, and `tests/db/tenancy.test.ts` pins the exact list of client-callable helpers.

## Open items for later steps

* Invitation emails: the admin copies the invite link for now; email delivery comes with notifications (X-06).
* Supervisor "own team" scoping and cleaner "own tasks" row filtering: with Tasks (step 8).
* Listing-scope RLS on listing tables: call `private.can_access_listing()` in step 3.
* Worker scheduling: choose Vercel Cron (Pro) or `pg_cron` + `pg_net` when deploying.
* DNS-rebinding window in the webhook SSRF guard (lookup vs. fetch); acceptable for the trial.
