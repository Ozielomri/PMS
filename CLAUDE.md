# PMS — project context for Claude Code

## What this is
A property management system (PMS) for short-term rentals, built as a technical trial to prove the core can be built. Benchmark competitor: Guesty. Built by Omri with Claude Code.

Full requirements: `docs/requirements.md` (requirement IDs PRP, CAL, RES, INB, AUT, TSK, X; priorities P0/P1/P2). Treat it as the source of truth. When a task names requirement IDs, implement exactly those and their acceptance criteria.

## Decisions (21 Nov 2026)
- Phase goal: technical trial, no pilot customers yet, no timeline or budget
- Target user: small US short-term-rental managers (5–50 units), mostly migrating from Guesty
- Channel: Booking.com only, via the direct Connectivity API (test properties first)
- Multi-units: in MVP (P0)
- Pricing: base nightly price + date-range overrides + weekly/monthly discounts; one rate per listing; no rate plans. Cleaning, extra-guest and pet fees stay. No tourist/occupancy tax.
- No payments, no AI reply drafts, no business model in this phase
- Staff app: responsive web / PWA only
- UI: English only; currency USD; units sq ft
- Privacy: US (CCPA/CPRA); Supabase in a US region

## Stack
- Next.js (App Router, TypeScript, strict mode) on Vercel
- Supabase: Postgres, Auth, Row Level Security, Storage, Realtime
- Tests: Vitest for unit, Playwright for e2e

## Engineering rules
- Calendar is the source of truth; only the calendar service changes availability.
- Never double-book: overlapping holds must fail atomically at the database level (constraints/locks), not in app code alone.
- Never hard-delete reservations, messages or tasks; log every state change to the audit log.
- Every state change emits a domain event (`reservation.created`, `calendar.updated`, ...).
- Dates as local dates in the listing timezone; timestamps in UTC; money as integer cents + currency code.
- Every table has RLS scoped to the account.
- Write tests first for the calendar engine and the reservation status machine.

## Build order
0. Check Booking.com Connectivity API access (credentials + test property)
1. Foundations: auth, accounts, users, roles (X-01, X-02), audit log (X-03), event bus (X-04)
2. Calendar engine (CAL-*)
3. Properties incl. multi-units (PRP-*)
4. Reservations + multi-calendar grid (RES-*, CAL screens)
5. iCal import/export (CAL-09, CAL-10)
6. Inbox, email first (INB-*)
7. Automations scheduler (AUT-*)
8. Tasks + staff PWA (TSK-*)
9. Booking.com integration (rates/availability push, reservation pull, messages)

Work one step at a time; finish acceptance criteria and tests before moving on.

## Reference
- Guesty teardown: https://claude.ai/artifact/8pNEN3rgv1WJRygknj7NjY
- Requirements (live doc): https://claude.ai/artifact/56HENDHgdU5KgYHCzpSMRp
