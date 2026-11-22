# Step 3 — Properties (PRP-01 … PRP-19)

Status: built 22 Nov 2026, in parallel with step 2 (Calendar). Interface with Calendar: [`step-2-3-contract.md`](step-2-3-contract.md).

Scope: PRP-01 … PRP-13, PRP-15, PRP-16, PRP-17, PRP-19. Out of scope: PRP-14 complexes, PRP-18 completeness score (P2). No tourist/occupancy tax (decision 21 Nov). USD, sq ft, English UI.

## Data model

`public.listings` (contract table) gets new columns in `20261122002100`; everything else is new tables. Every table has `account_id`, RLS, an audit trigger (X-03) and emits events (X-04). Child rows reference `(listing_id, account_id)` with a composite FK, so a row can never point at another tenant's listing.

| Table / columns | PRP | Notes |
| --- | --- | --- |
| `listings.address_line1/2, city, state_region, postal_code, country_code, latitude, longitude` | 02 | Geo-coordinates are entered or left empty; no geocoding provider in this phase (no network). Timezone is suggested from the US state in the UI (`src/lib/properties/timezone.ts`) and stays editable. |
| `listings.bedrooms, bathrooms_full, bathrooms_half, size_sqft` | 03 | Beds by type live on rooms. |
| `listings.cancellation_policy, cancellation_policy_notes` | 10 | `flexible, moderate, strict, non_refundable, custom`; a value only (refund maths: reservations). |
| `listings.cleaning_status, cleaning_status_updated_at` | 16 | Enum `clean, dirty, inspected, in_progress`; per *unit* (`single`, `sub_unit`); always null on `multi_parent`. |
| `listing_rooms` (name, type, `beds` jsonb `{king: 1, sofa_bed: 1}`, position) | 03 | Bed types validated by trigger. Photos can be assigned to a room. |
| `amenities` (global master list, `code, label, category, ota_codes`) + `listing_amenities` (code **or** custom label) | 04 | `ota_codes` is `{}` for now: the Booking.com facility codes are filled in step 9 against the Connectivity API docs (open item). |
| `listing_descriptions` (one row per language: summary, space, neighborhood, transit, house_rules, access_notes) | 05 | DB cap 10 000 chars; the UI shows counters against channel limits in `src/lib/properties/descriptions.ts`. |
| `listing_photos` (storage_path, position, caption, room_id, content type, size, width/height) | 06 | Cover = lowest position. Unique `(listing_id, position)` deferrable so reorder is one statement. |
| `custom_fields` (account-level: key, label, type `text, number, date, dropdown, secret`, options) + `listing_custom_values` | 12 | See *Secrets* below. |
| `listing_channel_links` (channel, external id, sync mode, status, last sync time/error) | 17 | Read-only for clients; written by the service role in step 9. |
| Change log | 19 | No new table: read from `audit_log` through `public.listing_change_log()`. |

Multi-units (PRP-13) use the contract columns `type` / `parent_id`. Content tables (rooms, amenities, descriptions, photos) refuse rows for a `sub_unit`: content and prices live on the parent. Custom values are allowed on sub-units (each physical unit has its own door code) and fall back to the parent's.

## Business rules and where they are enforced

All in the database (triggers on `listings` + deferred constraint triggers), so no client can bypass them. The UI only pre-checks to give better messages.

| Rule | Enforcement |
| --- | --- |
| **Activation** needs address (line 1, city, postal code, country), timezone, capacity (max guests, bedrooms, full bathrooms), base price > 0, check-in from + check-out by, ≥ 1 photo. A `multi_parent` also needs ≥ 1 non-archived sub-unit; a `sub_unit` needs an active parent that passes the checks. | `private.listing_activation_problems(id)` returns the missing items; a **deferred constraint trigger** on `listings` and `listing_photos` rejects the commit whenever an active listing fails them (also when someone later deletes the last photo or clears the price, or archives the last sub-unit of an active parent). `public.listing_activation_problems()` lets the UI show the checklist. |
| **Archive** blocked with future bookings | `before update` trigger calls `public.listing_has_future_bookings(id)` (Calendar's function; for a parent it covers sub-units). Archiving/restoring requires `properties.manage`. Archiving a parent archives its sub-units. Archived rows are never deleted (`delete` is revoked). |
| **Timezone change** with future bookings needs confirmation | Trigger rejects the change (`timezone_change_requires_confirmation`) unless it goes through `public.change_listing_timezone(id, tz, confirm => true)`. The UI asks first. Sub-units always carry their parent's timezone and currency (copied by trigger). |
| **Structure** (type/parent changes) | Only `sub_unit → single` (convert) and `parent_id` moves are allowed; both need `properties.manage` and are blocked when the sub-unit has future bookings; the target parent must be a non-archived `multi_parent` (contract FK + trigger). |
| Prices/rules apply to future dates only | Properties only writes `listings`; Calendar recalculates future nights itself (contract). Reservations snapshot fees (step 4). |
| Only admins create, duplicate, archive | `listings_insert` policy (`properties.manage`), RPCs check `properties.manage`, the trigger checks archive/restore and structure changes. `properties.edit` (managers) edits everything else. |
| Listing scope (X-01) | Child-table policies require `properties.view`/`properties.edit` **and** that the listing is visible (`exists (select … from listings)`, which applies the listing's own scope policy). Storage policies use `private.can_edit_listing_photo_path(name)`. |

## Secrets (PRP-12, X-15)

* Secret values are encrypted in the Next.js server with AES-256-GCM (`src/lib/crypto/secrets.ts`, `PMS_ENCRYPTION_KEY`), AAD = `listing_custom_value:<listing_id>:<field_id>`, so a ciphertext copied to another listing or field does not decrypt.
* The database only accepts the `v1.` ciphertext format (check constraint), so plaintext cannot be stored by mistake.
* Clients cannot select the ciphertext column (column grants; `secret_is_set` is exposed instead) and cannot write the table directly: writes go through `public.set_listing_custom_value()` / `clear_listing_custom_value()`. Reading ciphertexts for decryption: `public.listing_secret_ciphertexts()` (properties.edit + scope, or service role).
* Audit redacts the column (`audit_row_change('value_secret_ciphertext')`), events leave it out, the CSV export prints `[secret]`, and the UI masks values (reveal on click for editors). Tests cover each.
* Message variables (Inbox, step 6): `resolveListingVariables()` in `src/lib/properties/variables.ts` returns `custom.<key>` (and a few `listing.*`) values, decrypting secrets, with sub-unit → parent fallback. It never logs values.
* Duplicating a listing does not copy secret values (they are bound to the original row) — the admin re-enters them.

## Photos (PRP-06)

* Supabase Storage bucket `listing-photos` (public read, because channels fetch photo URLs; 25 MB limit; JPEG/PNG/HEIC/HEIF). Path `<account_id>/<listing_id>/<uuid>.<ext>`. The browser uploads straight to Storage (server actions have a 1 MB body limit), then a server action records the metadata row. Bucket + policies are created only when the `storage` schema exists, so migrations also run on plain Postgres.
* **Variants: Supabase image transformations** (`/storage/v1/render/image/...?width=…`), presets in `src/lib/properties/photos.ts` (thumb 320, medium 1024, large 2048). Chosen because it needs no worker, no extra dependency and no stored copies, and it decodes HEIC (browsers can't) and serves WebP to browsers. Needs the Supabase Pro plan; if that is unavailable, swap `photoUrl()` for server-side `sharp` resizing on upload — the metadata model does not change.
* Deleting a photo removes the metadata; the storage object is removed only when no other row (a duplicate) still references the path.

## Screens

| Screen | Route |
| --- | --- |
| Property list (photo, name, type, city, tags, status, cleaning status, channels; filters tag/city/type/status; search; multi-select bulk edit; CSV export) | `/properties` |
| Create wizard (type, name, address, capacity, base price, times → photos → activate) | `/properties/new` → `/properties/[id]?tab=photos&wizard=1` |
| Property editor: tabs Overview, Location, Rooms and beds, Amenities, Descriptions, Photos, Booking rules, Fees, Custom fields, Channels, Log. Autosave per tab (debounced), unsaved-change warning on tab switch and page leave | `/properties/[id]?tab=…` |
| Multi-unit view (parent header, sub-units with cleaning status and next arrival; add, remove, move, convert) | `/properties/[id]/units` |
| Custom field definitions (admins) | `/properties/custom-fields` |

## Interpretation calls (for review)

1. "Capacity" for activation = max guests + bedrooms (0 = studio) + full bathrooms.
2. "Address" = line 1, city, postal code, country; geo-coordinates optional (no geocoder).
3. Moving a sub-unit and converting it to a single unit are structural, so they need `properties.manage` (admin) like add/remove. Both are blocked while the sub-unit has future bookings.
4. Removing a sub-unit = archiving it (never deleted). Archiving the last sub-unit of an active parent is blocked.
5. Parent status cascades: activating a parent activates its draft sub-units; draft/archive cascades too.
6. Bulk edit of price/rules/fees/times/amenities rejects sub-units (they inherit); tags work on any listing.
7. Custom field definitions are account settings → `properties.manage`. Secret reveal → `properties.edit`.
8. Tags are trimmed and de-duplicated case-insensitively on write.
9. "Next arrival" in the multi-unit view and "affected bookings" in the timezone dialog need reservation data (step 4); for now they show what `listing_has_future_bookings` tells us.
10. Channel description limits are placeholders to verify against Booking.com in step 9.

## Events (added to the catalog)

`listing.status_changed`, `listing.cleaning_status_changed` (both besides `listing.updated`), `listing.content_updated` (rooms, amenities, descriptions, photos, custom values; payload names the section, never secret values), `custom_field.created/updated`, `listing_channel_link.created/updated`.
