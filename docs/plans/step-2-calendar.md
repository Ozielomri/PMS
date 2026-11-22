# Step 2 — Calendar engine (CAL-01 … CAL-08, CAL-11 … CAL-15)

Status: built 22 Nov 2026. Out of scope: iCal (CAL-09/10, step 5; the `ical` hold type is ready for it), gap rules (CAL-16, P2) and the calendar screens (step 4). Interface with Properties: [`step-2-3-contract.md`](step-2-3-contract.md).

## Data model

| Table | Rows | Purpose |
| --- | --- | --- |
| `calendar_days` | one per **root** listing (single, multi_parent) per night | Stored per-night *overrides*: `price_override_cents`, `min_nights_override`, `max_nights_override`, `closed_to_arrival`, `closed_to_departure`, `closed`. Null/false = the listing default applies. Also the lock target for writes (see concurrency). |
| `calendar_holds` | one per cause | Everything that makes nights unavailable: `source_type` in `reservation`, `quote`, `owner_stay` (*exclusive*), `manual_block`, `ical` (*non-exclusive*). `[check_in, check_out)` nights, `source_id` (reservation id, …), `status` `active → released / expired` (final), optional `expires_at`. Never deleted. |
| `calendar_changes` | change log (CAL-13) | `listing_id`, `nights` (daterange), `field`, `old_value`, `new_value`, `source` (`user`, `automation`, `channel`, `pricing_tool`, `api`, `system`), actor, IP, request id. Append-only. Consecutive nights with the same old → new are stored as one range row. |
| `calendar_api_tokens` | per account | Hashed bearer tokens for external pricing tools (CAL-15). |
| `private.calendar_pending_events` | scratch, per transaction | Collects listing + date range + change kinds; flushed into one `calendar.updated` event per listing at commit (CAL-14). |

**Effective values are derived at read time, not materialised.** Price = override, else weekend price on the listing's `weekend_nights`, else base price; min/max nights = override, else listing default. Status and block reasons are derived from holds and the listing's rules. Consequences:

* A listing edit (base price, min nights, …) is visible on every future night, including all sub-units of a multi-unit parent, the moment it commits (PRP acceptance "within 5 s"). A trigger on `listings` writes the per-night change log for the affected nights and emits `calendar.updated`; Properties calls nothing.
* Nothing to recompute when a reservation moves: preparation time (CAL-08) is derived from the current position of each exclusive hold.
* Holds carry no price. Reservations (step 4) snapshot a `quote_stay` result; later price edits cannot touch it.

**Multi-units (CAL-11).** Only roots have `calendar_days` rows; a sub-unit uses its parent's prices and rules. Availability is per sub-unit (its holds). A parent's night shows `units_total` / `units_available` (= allotment) and is available when at least one sub-unit is. `place_hold` on a parent assigns the first sub-unit (by name) that is free for the *whole* stay; `move_hold` reassigns. A manual block on the parent closes the whole group (inherited by every sub-unit); exclusive holds are never on a parent.

**Block reasons** per night: `reservation`, `quote`, `owner_stay`, `manual_block`, `ical_import` (each with `hold_id`, `source_type`, `source_id`, note), `preparation` (with the causing `hold_id`), `advance_notice`, `booking_window`, `default_closed`. Status: `booked` (reservation/quote), else `blocked` (any reason), else `available`.

## Concurrency (CAL-03)

Two layers:

1. **Exclusion constraint** (btree_gist) on `calendar_holds (listing_id =, nights &&) where exclusive and status = 'active'`. Two reservation-type holds can never overlap on a unit, whatever code path writes them. This is the "never double-book" guarantee.
2. **Row locks on the root's night rows.** Every write that changes availability (`place_hold`, `move_hold`, `block_dates`, `update_calendar`) first locks the root listing's `calendar_days` rows for the affected nights ± preparation nights (`for update`, ordered by listing then night, so no deadlocks). This serialises check-then-insert for the rules the constraint cannot express: preparation gaps, manual/iCal blocks, closed nights, and the choice of a free sub-unit. Under READ COMMITTED each statement after the lock sees the winner's commit.

Why not one or the other alone: the constraint cannot see preparation time (it depends on a listing setting that can change) or non-exclusive blocks; locks alone would depend on every future writer remembering to lock. Locks live in the tuple, not in the shared lock table, so a bulk block of 20 listings × 365 nights is fine.

Expired holds (`expires_at <= now()`) never block reads or checks; writers flip overlapping ones to `expired` before inserting, and `expire_calendar_holds()` sweeps the rest.

## Rules and interpretation calls

* Nights are half-open everywhere: `[check_in, check_out)`, `[from, to)`. Check-out day is not a booked night.
* **Min/max nights and CTA** are read on the arrival night, **CTD** on the departure date.
* **Advance notice**: the first bookable arrival date is the listing-local date of `now() + advance_notice_hours`. Nights before it carry `advance_notice` (this includes past nights).
* **Booking window**: nights on or after `today + booking_window_days` (listing-local) carry `booking_window`; every night of a stay must be inside the window.
* **Capacity**: `guests > max_guests` of the rules listing (parent for a sub-unit).
* **Preparation time** (`preparation_nights` = N) applies before *and* after each exclusive hold, so two stays on a unit need a gap of at least N nights.
* `place_hold` hard-fails (SQLSTATE `23P01`, message `calendar_conflict: …` naming the conflicting reservation) on other holds, manual/iCal blocks, closed nights and preparation conflicts. Stay rules (min/max, CTA/CTD, notice, window, capacity) are checked only with `p_enforce_rules => true`, because channel bookings and manager overrides must still land. Reservations call `check_availability` first.
* Manual blocks may not cover nights of an exclusive hold on the same unit (that would make a night unavailable twice); bulk blocking is all-or-nothing and the error names every conflict. Preview mode lists them without writing. A block on a multi-unit parent is allowed while some sub-units are booked (it stops selling the rest).
* iCal holds (step 5) never fail: an external booking must be stored even when it overlaps; it shows as a second reason on that night.
* Bulk edits (CAL-12) of a sub-unit apply to its parent (rules live on the parent). Price ops: `set`, `add` (± cents), `percent` (± %, rounded half-up), `reset` (back to base). A result below 0 is rejected. Relative ops skip nights without any price and report them as `skipped`.
* Quote (CAL-05): nightly sum + extra-guest fee (per guest above `extra_guest_after`, per night) + cleaning fee (per stay) + pet fee (per stay when pets > 0) − length-of-stay discount on the nightly sum only (monthly from 28 nights, else weekly from 7 nights; basis points, rounded half-up). No tax lines (decision 21 Nov). Implemented once in SQL; `src/lib/calendar/quote.ts` mirrors it for previews and a DB test pins parity.
* Calendar rows exist for draft and active roots (so a listing can be prepared and blocked before activation). Reservation, quote and owner-stay holds need an **active** listing (and an active parent for a sub-unit); manual blocks are allowed on drafts; archived listings take no new holds and are not extended (requested by Properties, 22 Nov). `check_availability` reports `listing_not_active` for drafts. Only active sub-units are auto-assigned and count towards the allotment.
* Capacity uses the rules listing's `max_guests` (the parent's for a sub-unit).
* Horizon (CAL-01): rows through `today + max(730, booking_window_days)` in the listing timezone, created on insert/activation and extended by `extend_calendar_horizon()`. Reads beyond the stored rows still work (overrides simply absent), and writers create missing rows on demand.
* Audit: holds and API tokens use the generic audit trigger (X-03). Per-night override edits are audited in `calendar_changes` (same actor/IP/request-id fields), to avoid one audit row per night per bulk edit.

## API

SQL (schema `public`; security definer with explicit permission + listing-scope checks; service role and direct DB connections act as system):

| Function | Who | Purpose |
| --- | --- | --- |
| `check_availability(listing, check_in, check_out, guests, ignore_hold_id?)` → `(bookable, reason, failures[], message, nights, unit_id, conflicts)` | `calendar.view`, service role | CAL-02 |
| `quote_stay(listing, check_in, check_out, guests, pets)` → jsonb lines | `calendar.view`, service role | CAL-05 |
| `get_calendar(listing_ids[], from, to)` → per listing-night price, source, rules, status, reasons, allotment | `calendar.view` (scope-filtered), service role | grid read |
| `place_hold(listing, check_in, check_out, source_type, source_id, expires_at, note?, block_reason?, enforce_rules?, guests?)` → hold id | service role only (Reservations call it from their own security-definer RPCs) | CAL-03/11 |
| `release_hold(hold_id, reason?)`, `move_hold(hold_id, check_in, check_out, listing?)` → unit id | service role only | free nights; alterations, relocation, CAL-11 reassignment |
| `block_dates(listing_ids[], from, to, reason, note, preview)`, `unblock_dates(listing_ids[], from, to, preview)` | `calendar.block` | CAL-07 |
| `update_calendar(listing_ids[], from, to, changes jsonb, days_of_week[]?, preview)` | `calendar.edit` | CAL-04/06/12 |
| `get_night_changes(listing, night)` | `calendar.view` | CAL-13 |
| `listing_has_future_bookings(listing)` | listing readers | contract (replaces the stub) |
| `listing_future_holds(listing)` → (hold_id, listing_id, source_type, source_id, check_in, check_out, expires_at, note) | `properties.view` or `calendar.view`, in scope | Properties: timezone-change confirmation |
| `next_arrivals(listing_ids[])` → (listing_id, check_in, hold_id, source_type, source_id, unit_id) | same (unreadable listings skipped) | Properties: multi-unit view |
| `create_pricing_tool_token(account, name)`, `revoke_pricing_tool_token(id)` | `calendar.manage` | CAL-15 setup |
| `apply_pricing_tool_updates(token, updates jsonb)` | service role only | CAL-15 |
| `extend_calendar_horizon()`, `expire_calendar_holds()` | service role only | CAL-01 job |

Route handlers (`src/app/api/calendar/**`):

* `GET /api/calendar/availability`, `GET /api/calendar/quote` — signed-in user, RLS/permissions in SQL.
* `POST /api/calendar/machine/pricing-tool` — `Authorization: Bearer pmspt_…` (per-account token, hashed in the DB). The handler uses the service-role client and the RPC resolves the account from the token, so a tool can only touch its own account; every change is logged with source `pricing_tool`.
* `GET|POST /api/calendar/machine/maintenance` — `Authorization: Bearer $CRON_SECRET`, like `/api/internal/*`. Vercel Schedules run it hourly (horizon extension + hold expiry; both idempotent).

`/api/calendar/machine/` is added to the public prefixes in `src/lib/auth/routes.ts` (machines have no session cookie; the handlers authenticate themselves).

TypeScript (`src/lib/calendar/`): `dates.ts`, `quote.ts`, `bulk.ts` (pure, unit-tested), `schemas.ts` (zod input validation), `service.ts` (typed RPC wrappers for Reservations and the step-4 screens).

## Performance notes

* `private.calendar_nights` is a SQL function, planned generically; every join is a correlated `LATERAL … offset 0` index probe so it never hashes `calendar_days`.
* JIT is switched off on the calendar functions (`alter function … set jit = off`): JIT compilation cost 50–150 ms per call against estimates of a few ms of work.

## Events (CAL-14)

One `calendar.updated` per listing per transaction: `{listing_id, date_from, date_to (exclusive), changes: [...]}` with change kinds `availability`, `price`, `min_nights`, `max_nights`, `closed_to_arrival`, `closed_to_departure`, `closed`, `rules`. A hold on a sub-unit also emits for its parent (allotment); a rule change on a parent also emits for each sub-unit. Ranges include preparation nights.

## Tests and acceptance

* Unit: dates, quote maths, bulk price ops, input schemas.
* DB (`tests/db/calendar-*.test.ts`): horizon generation/extension; every availability rule incl. timezone-dependent advance notice; holds, overlap error naming the reservation, adjacent stays, expiry, release, move + preparation recalculation, hold status machine, exclusion constraint bypass attempt; multi-unit allotment/auto-assign/reassign; prices base/weekend/override, quote lines + TS parity; bulk preview = apply counts; change log sources; one event per listing per transaction; listing edits → sub-unit prices + events; permissions per role; pricing-tool tokens.
* Acceptance (22 Nov 2026, Postgres 16 in the build sandbox):

| Criterion | Result |
| --- | --- |
| 1,000 concurrent `place_hold` on one night, 40 connections | 1 success, 999 × `23P01`, 7.6 s total |
| 400 overlapping random stays, 3-unit multi-unit × 300 attempts | 0 overlapping holds; exactly 3 successes on 3 distinct units |
| `get_calendar` 50 listings × 31 days (≈ 250k days in the table, as a manager) | 79–88 ms |
| Manual block on 20 listings + grid read + 20 `calendar.updated` events | 131 ms |
