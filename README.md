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

Two idempotent endpoints, protected by `Authorization: Bearer $CRON_SECRET`; overlapping runs are safe:

- `POST /api/internal/webhooks/dispatch` sends due webhook deliveries
- `POST /api/internal/events/process` runs internal event consumers (none registered until automations, step 7)

**Vercel Schedules** call both every minute (`vercel.json`). This needs the **Pro plan**: Hobby limits schedules to once every 15 minutes. Set `CRON_SECRET` in the project's environment variables; Vercel sends it as the bearer token. Schedules run against the production deployment only; locally, call an endpoint by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/internal/webhooks/dispatch
```

## Layout

```
supabase/migrations/   SQL: helpers + audit (000100), events (000200), accounts/roles (000300), webhooks (000400), realtime/cron (000500)
src/lib/auth/          permissions matrix, MFA gate, auth context (DAL), safe redirects
src/lib/events/        event catalog, envelope type, internal bus worker
src/lib/webhooks/      dispatcher, HMAC signatures, SSRF guard, Supabase RPC stores
src/lib/crypto/        AES-256-GCM field encryption
src/app/               pages: login, signup, mfa, onboarding, invite, dashboard, settings (team, webhooks, audit)
tests/unit|db|e2e/     Vitest unit, Vitest + Postgres, Playwright
```

## Calendar engine (step 2)

Design: [`docs/plans/step-2-calendar.md`](docs/plans/step-2-calendar.md). SQL API in `supabase/migrations/20261122001000_calendar_core.sql`, typed wrappers in `src/lib/calendar/service.ts`.

- `GET /api/calendar/availability` and `GET /api/calendar/quote`: signed-in users (permissions checked in SQL).
- `POST /api/calendar/machine/pricing-tool`: external pricing tools, `Authorization: Bearer pmspt_…` (create a token with `public.create_pricing_tool_token`, `calendar.manage`).
- `/api/calendar/machine/maintenance`: hourly Vercel Schedule (`CRON_SECRET`), keeps 730+ days generated and expires overdue holds.
