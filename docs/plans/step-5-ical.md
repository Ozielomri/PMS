# Step 5 — iCal import and export (CAL-09, CAL-10)

Scope: CAL-09 (export URL per listing, availability only) and CAL-10 (import feeds per listing, polled every 15 minutes, events become `ical` holds, last result and errors shown), plus the "iCal settings" screen of Module 2. Builds on the calendar engine (step 2): the `ical` hold type, `place_hold_internal`, `release_hold` and the `ical_import` block reason already exist.

## Data model (migration `20261124001000_ical.sql`)

| Table | Purpose |
| --- | --- |
| `ical_exports` | One row per export URL of a listing. `token_hint` (last 4), `token_ciphertext` (AES-256-GCM with `PMS_ENCRYPTION_KEY`, context = export id, so the UI can show the URL again), `revoked_at`. At most one active row per listing (partial unique index). Rotate = revoke + new row. |
| `private.ical_export_tokens` | `sha256(token)` → export id, plus `last_accessed_at`. The only lookup path for the public URL; no client role can read it. |
| `ical_feeds` | Import subscriptions: listing, name ("Airbnb"), `url_ciphertext` (feed URLs carry the channel's own secret, X-15), `url_hash` (dedupe per listing), `url_display` (host + shortened path), `active`/`removed_at` (soft delete), run state: `status` (`pending`, `ok`, `conflict`, `error`), `last_run_at`, `last_success_at`, `last_error`, `events_imported`, `last_result` (placed / moved / released / skipped), `conflicts`, `etag`, `last_modified`, `consecutive_failures`, `next_run_at`, `locked_until`. |
| `ical_feed_events` | One row per imported external event: feed, `uid`, `check_in`, `check_out`, current `hold_id`, `status` (`active` → `removed`, final). The hold's `source_id` is this row's id. Never deleted. |

RLS: feeds and exports are readable with `calendar.manage` (and listing scope); feed events with `calendar.view` (they explain `ical_import` blocks on the grid). Clients get no insert/update/delete: every write is a security-definer RPC.

## Export (CAL-09)

* `GET /ical/<token>.ics` (public prefix `/ical/`): the route checks the token format, then calls `public.ical_export_calendar(token)` with the publishable key (granted to `anon`; the 256-bit token is the credential). The function resolves the token hash, returns the listing timezone and the busy ranges; no guest data ever leaves the database (no names, codes or notes).
* Busy night = any reason from a hold (reservation, quote, owner stay, manual block, iCal import), preparation time or default closed, from today (listing-local) for 730 nights. Advance notice and booking window are left out: they are time-relative booking rules every channel configures itself, and would make the feed shift every day.
* Multi-unit parent: a night is busy when the parent itself is blocked or no active sub-unit is free. Sub-units export their own holds (plus parent blocks, which close them too).
* Consecutive busy nights are merged into one all-day `VEVENT` (`DTSTART;VALUE=DATE` / exclusive `DTEND;VALUE=DATE`, `SUMMARY:Not available`, `TRANSP:OPAQUE`). `UID` = start date + hash of the listing id, so an unchanged block keeps its UID across fetches and an extended block keeps it too (only `DTEND` changes).
* RFC 5545: CRLF line ends, lines folded at 75 octets (UTF-8 aware), `VERSION`, `PRODID`, `CALSCALE`, `METHOD:PUBLISH`, `DTSTAMP` in UTC. `Cache-Control: private, max-age=0, must-revalidate`, a strong `ETag` over the events (304 on `If-None-Match`), `X-Robots-Tag: noindex`.
* UI: copy, rotate (old URL stops working at once), revoke. Rotation and revocation are audited and emit `ical_export.created` / `ical_export.updated`.

## Import (CAL-10)

Pipeline (`src/lib/ical/`):

1. `fetch.ts` — SSRF guard (the webhook `url-guard`, generalised with `validatePublicUrl`), `https` only (http and private hosts only with `WEBHOOKS_ALLOW_PRIVATE_NETWORKS=1` for local development), 15 s timeout, 5 MB limit (streamed, aborted past the limit), up to 3 redirects each re-checked by the guard, conditional GET (`ETag` / `Last-Modified` → 304 = unchanged).
2. `parse.ts` — RFC 5545 unfolding, parameters (quoted values), text unescaping; `VEVENT`s only. `DATE`, UTC `DATE-TIME`, `TZID` (IANA names; unknown ones are treated as the listing timezone) and floating times; `DTEND` or `DURATION`.
3. `normalize.ts` — events → desired blocks in the listing timezone: `check_in` = local date of `DTSTART`, `check_out` = local date of `DTEND`, at least one night (a same-day event blocks that night). Skipped: `STATUS:CANCELLED` (so a cancelled booking is released), recurring events (`RRULE`, `RECURRENCE-ID`: ignored, counted as skipped), events that ended before today, invalid dates. Duplicate UIDs keep the highest `SEQUENCE`. Events without a UID get one derived from their dates. Blocks longer than 1,100 nights are cut. At most 5,000 events per feed.
4. `public.apply_ical_feed_sync(feed_id, events, meta)` — the diff, in one transaction with the feed row locked: new UID → insert event + `place_hold_internal(..., 'ical', event id)`; changed dates → release the old hold, place a new one (iCal holds are not movable by design); vanished UID → release + mark removed; an event whose hold is no longer active gets a new one. `events = null` (HTTP 304) keeps everything. Only the calendar functions change availability.
5. Conflicts: after the diff, every active event is checked against active exclusive holds (reservations, owner stays, quotes) on the same unit (on any sub-unit for a parent feed). iCal holds never fail (calendar rule: an external booking is always recorded), so nothing is double-booked in the PMS and nothing is deleted; the overlap is stored on the event and the feed (`status = conflict`, `last_error` naming the reservation codes) and shown in the UI.
6. Failure (`public.record_ical_feed_failure`): fetch/parse errors keep every existing block (business rule), set `status = error`, `last_error`, count consecutive failures and back off (15 min × failures, at most 1 h).

Worker: `POST /api/internal/ical/sync` (`CRON_SECRET`), claims due feeds with a lease (`claim_ical_feeds`, `for update skip locked`, so overlapping runs never sync a feed twice), 4 in parallel, until ~45 s are used. Due = `next_run_at <= now() + 2 min` so a 15-minute schedule never skips a run. Schedule `*/15 * * * *` goes into the TODO block (Hobby plan). "Sync now" in the UI runs the same pipeline as the signed-in user (permission checked in SQL), so the audit log shows who did it.

Events: `ical_feed.created` / `ical_feed.updated` (settings, removal; row trigger limited to settings columns so the 15-minute runs do not flood the audit log), `ical_feed.synced` (when holds changed or the status changed; payload: counts and status, no guest data), `ical_feed.sync_failed` (on a new error), and `calendar.updated` from the hold functions.

## Permissions

| Action | Permission |
| --- | --- |
| See / create / rotate / revoke export URL, add / remove feeds, sync now | `calendar.manage` (admin) within listing scope |
| See which feed an iCal block came from (`ical_feed_events`) | `calendar.view` |
| Worker functions (`claim_ical_feeds`) | service role |

## Tests

* Unit (`tests/unit/ical.test.ts`): parser (folding, CRLF/LF, params, escapes, DATE / DATE-TIME / TZID / floating, DURATION, CANCELLED, RRULE, Airbnb- and Vrbo-style fixtures), normalisation (timezone conversion, one-night minimum, past events, duplicates), generator (CRLF, folding at 75 octets incl. multi-byte, required properties, round trip through the parser, stable UIDs), range merging, fetch (size limit, timeout, redirects, SSRF, 304) with a stubbed `fetch`.
* DB (`tests/db/ical.test.ts`): export tokens (hash lookup, rotate, revoke, anon access, no guest data, multi-unit parent busy only when all units busy, sub-unit), feed RPCs (permissions per role, dedupe, removal releases holds), sync diff (place, change dates, vanish, cancelled, 304, self-heal, idempotent re-run), failure keeps blocks, conflict recorded with reservation kept, events and audit, worker claim lease; tenancy and grant lists.
* e2e smoke: the public `.ics` route answers without a session (404 for an unknown token, not a redirect), the worker rejects requests without the cron secret, the editor's iCal tab needs sign-in.
