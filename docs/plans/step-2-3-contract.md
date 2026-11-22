# Steps 2 + 3 — interface contract between Calendar and Properties

Calendar (step 2, CAL-*) and Properties (step 3, PRP-*) are built in parallel. This file fixes what each side may rely on so the two can be merged without rework.

## Shared table: `public.listings`

Defined in `supabase/migrations/20261122000100_listings_core.sql` (owned jointly; do not rename or drop its columns).

| Columns | Meaning |
| --- | --- |
| `id, account_id, type (single, multi_parent, sub_unit, complex), parent_id, status (draft, active, archived)` | Identity and structure. `sub_unit` rows have a `multi_parent` parent. `complex` is P2: not bookable. |
| `internal_name, public_title, timezone, currency, tags, max_guests` | Basics. All calendar dates are local dates in `timezone`. |
| `check_in_from, check_in_to, check_out_by` | Default times (PRP-07) |
| `base_price_cents, weekend_price_cents, weekend_nights, min_nights, max_nights, advance_notice_hours, preparation_nights, booking_window_days, instant_book` | Booking defaults (PRP-08) |
| `weekly_discount_bps, monthly_discount_bps` | Length-of-stay discounts (CAL-05), basis points |
| `cleaning_fee_cents, extra_guest_fee_cents, extra_guest_after, pet_fee_cents` | Fees (PRP-09). No tourist tax. |

Rules:

* **Multi-units.** For a `sub_unit`, booking and pricing columns are ignored; the parent's apply. Availability and cleaning status are per sub-unit.
* **Writes.** Only admins create listings (`properties.manage`); `properties.edit` edits. Listing scope applies through `private.can_access_listing(account, id, private.listing_scope_tags(listing))`.
* Events `listing.created` / `listing.updated` are emitted by a trigger already.

## Ownership

| Calendar owns | Properties owns |
| --- | --- |
| Migrations `20261122001xxx_*.sql` | Migrations `20261122002xxx_*.sql` |
| `src/lib/calendar/**`, `src/app/api/calendar/**`, `tests/**/calendar*` | `src/lib/properties/**`, `src/app/(app)/properties/**`, `tests/**/propert*` |
| All per-night data (calendar days, overrides, blocks, holds, change log), availability, quotes, allotment | Descriptive tables (rooms, amenities, descriptions, photos, custom fields, change log), cleaning status, archive/activate rules, editor UI |
| **Reacting to listing changes:** when booking/pricing columns change, the calendar recalculates future nights itself (trigger or function on `listings`). PRP acceptance "parent base price → sub-units' future calendar prices within 5 s" is satisfied by this. | **Calling into the calendar:** none required. Properties must not write calendar tables. To check "future reservations / blocks" (archive, timezone change), call the calendar's read function `public.listing_has_future_bookings(listing_id)` — Calendar provides it. |

Calendar API both sides rely on (SQL, in schema `public` unless noted):

* `public.check_availability(listing_id, check_in date, check_out date, guests int)` → `(bookable boolean, reason text, ...)`
* `public.place_hold(listing_id, check_in, check_out, source_type text, source_id uuid, expires_at timestamptz)` → hold id; fails atomically on overlap (CAL-03). Reservations (step 4) will call this.
* `public.release_hold(hold_id)`
* `public.listing_has_future_bookings(listing_id)` → boolean

## Shared files

Both sides may append to these; the merge resolves conflicts:

* `src/lib/events/catalog.ts` (add event types)
* `src/app/(app)/layout.tsx` (NAV entries)
* `tests/db/tenancy.test.ts` (`ACCOUNT_SCOPED_TABLES`; the private-function allowlist)
* `src/lib/auth/permissions.ts` — do **not** change the matrix.

## Merge notes (22 Nov 2026)

* Both branches merged. Calendar test fixtures (`tests/db/calendar-fixtures.ts`) now create complete listings with a photo, so they pass the Properties activation rule.
* Calendar provides `listing_future_holds()` and `next_arrivals()`; the Properties timezone dialog lists affected reservations / owner stays and the multi-unit view shows each sub-unit's next arrival.
* `place_hold` refuses archived listings, and reservation / quote / owner-stay holds on drafts.
* After the merge: 306 Vitest tests (unit + db), lint, typecheck, build and 18 Playwright smoke tests pass.
