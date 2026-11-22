# Step 4 — Reservations + calendar screens

Scope: RES-01 … RES-14, RES-16 … RES-19 (P0 + P1; RES-15 group reservations is P2) and the calendar screens of Module 2 (multi-calendar grid with its interactions, single-listing calendar, bulk edit panel). iCal settings stay in step 5. Messages and Tasks tabs on the reservation page are placeholders until steps 6 and 8.

## Data model (migrations `20261123000xxx`)

| Table | Purpose |
| --- | --- |
| `guests` | RES-12 guest record; `merged_into_id` after a merge (never deleted) |
| `reservations` | One row per booking: status, stay status, listing + assigned unit, dates, guest counts, source, channel confirmation code, snapshotted currency and cancellation policy, approval deadline, calendar hold |
| `reservation_lines` | RES-08/09 money: accommodation, fees, discount, extras, adjustments, cancellation, channel commission. Append-only: edits are new adjustment lines |
| `reservation_payments` | RES-10 payments recorded outside the system (negative = refund). Append-only |
| `reservation_balances` (view) | guest total, commission, host payout, paid, balance due — only for `reservations.view_money` |
| `reservation_activity` | RES-18 activity log (status, alterations, money, notes) |
| `reservation_notes`, `reservation_files` | RES-17 (files in a private Storage bucket) |
| `reservation_source_settings` | RES-04 approval hours per source (default 24) |
| `reservation_saved_views` | RES-13 saved filters (own or shared) |
| `quotes`, `quote_options` | RES-05 priced options, share link (token), optional hold, expiry |

Money never lives on `reservations` itself, so a supervisor (`reservations.view` without `view_money`) sees bookings but no amounts — enforced by RLS.

## Rules and where they live

* **Status machine (RES-03)** — a trigger on `reservations` allows exactly: inquiry → reserved / confirmed / closed; reserved → confirmed / declined / expired; confirmed → canceled. Final statuses accept only tag and guest-merge changes. Stay status (upcoming → checked-in → checked-out, or no-show) exists only while confirmed.
* **Calendar** — every write goes through the Calendar API from security-definer RPCs: reserved = time-limited reservation hold (expires at the approval deadline, so nights free themselves even before the expiry sweep runs); confirmed = hold without expiry; owner stay = `owner_stay` hold; decline / expire / cancel release the hold; alterations use `move_hold` (atomic, fails without changing anything). No double-booking path exists outside the calendar's exclusion constraint.
* **Money (RES-08)** — lines are snapshotted at creation from `quote_stay` (CAL-05); a manual price override adds an adjustment line with the reason. Alterations show before/after and add one adjustment line for the difference. Lines of channel bookings come from the channel and are read-only. 30 days after check-out only adjustments (with reason) can be added.
* **Cancellation (RES-07)** — refundable share from the snapshotted policy and the days left before check-in (listing-local): flexible 100 % ≥ 1 day / else 0 %; moderate 100 % ≥ 5 days / else 50 %; strict 50 % ≥ 7 days / else 0 %; non-refundable 0 %; custom: entered by a user with `reservations.manage`. Host and channel cancellations refund 100 %. A cancellation line brings the guest total down to the kept amount; refund due = paid − kept (if positive).
* **Channel ingest (RES-02)** — `ingest_channel_reservation(account, source, external_code, payload)` (service role): create / modify / cancel, idempotent on (account, source, external code) with an advisory lock plus a unique constraint. Changes to channel bookings made in the PMS (dates, listing, guests, cancel) are refused with "change it on the channel".
* **Approval deadline (RES-04)** — set from `reservation_source_settings`; `expire_overdue_reservations()` moves overdue Reserved → Expired and overdue inquiries (check-in passed) → Closed. It runs from a worker route (schedule waits for Pro, see TODO) and also when a member opens the reservation list or Today view, so it works on Hobby.
* **Events (RES-19)** — `reservation.created`, `reservation.updated`, `reservation.status_changed`, `reservation.dates_changed` from a trigger.

## Permissions

| Action | Permission |
| --- | --- |
| Create reservation / quote / owner stay, convert inquiry | `reservations.create` |
| Approve, decline, close, alter, stay status, ETA/ETD, notes, files, extras, record payment | `reservations.edit` (money ones also `view_money`) |
| Cancel | `reservations.cancel` |
| Adjustments, custom refund %, merge guests, approval settings | `reservations.manage` |

## Screens

1. **Reservations** list: quick tabs (Arriving today, Departing today, In house, Pending approval, Upcoming), filters (status, stay status, listing, tag, source, check-in/out range, created date, balance due), saved views, CSV export.
2. **Reservation page**: header with status actions; tabs Overview, Guest, Financials, Messages (step 6), Tasks (step 8), Notes and files, Activity.
3. **Create reservation / quote** pages, prefilled from a calendar selection, with live price and availability warnings.
4. **Alteration** page with before/after comparison.
5. **Today** section on the dashboard: arrivals, departures, pending approvals, unpaid balances.
6. **Calendar** grid (rows = listings, grouped by multi-unit; columns = days; bars by channel; blocks hatched; price and min nights in empty cells; sticky header and listing column; jump to date; zoom week / 2 weeks / month; filters). Drag across empty cells → create reservation, create quote, block, edit price / min nights. Click a bar → side panel. Drag a bar to another row → relocate (availability checked, confirmation asked).
7. **Single-listing calendar** (month) and **bulk edit** panel (preview count, apply).
8. **Quote link** page `/q/[token]` for the guest, and global search (X-08) in the top bar.

## Tests

* DB: every allowed and every illegal status transition; double-submitted channel webhook → one reservation (concurrent); extending into a blocked night fails and changes nothing; refunds per policy; money append-only and 30-day lock; RLS per role (supervisor no money, front office no cancel, cleaner nothing); quotes accept with re-check; expiry sweep; events.
* Unit: TS mirrors of the status machine and refund rules, CSV export, input schemas.
