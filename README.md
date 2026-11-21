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

Two idempotent endpoints, protected by `Authorization: Bearer $CRON_SECRET`; call each every minute (overlapping runs are safe):

- `POST /api/internal/webhooks/dispatch` — sends due webhook deliveries
- `POST /api/internal/events/process` — runs internal event consumers (none registered until automations, step 7)

Options: Vercel Cron (per-minute schedules need a Pro plan), or Supabase `pg_cron` + `pg_net`:

```sql
select cron.schedule('pms-webhooks', '* * * * *', $$
  select net.http_post(
    url := 'https://<your-app>/api/internal/webhooks/dispatch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))
  ) $$);
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
