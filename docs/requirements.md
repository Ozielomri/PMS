# PMS Requirements: Core Modules 1–6

Nov 21, 2026 · @Omri

## Scope and principles

This document specifies the six core modules a PMS needs to replace Guesty for a short-term-rental operator: Properties, Calendar, Reservations, Unified Inbox, Automations and Tasks. Channel connections, payments, owner accounting, guest app and direct booking are out of scope here; where a core module depends on them, the dependency is named as an interface.

**Target user:** a US-based short-term-rental manager with 5–50 units, typically migrating from Guesty, a small office team and outsourced or in-house cleaners. Single operator account, multiple staff users.

**Product principles**

- **The calendar is the source of truth.** No booking, block or price exists outside it; every other module reads from it.
- **Never lose a record.** Reservations, messages and tasks are never hard-deleted; state changes are logged.
- **Never double-book.** Any write that would make a night unavailable twice is rejected, not warned.
- **Event-driven.** Every state change emits a domain event; automations, webhooks and the UI subscribe to the same events.
- **Bulk by default.** Every edit that makes sense across listings (price, min nights, block, tag) works on a selection.

**Conventions**

- Requirement IDs: `PRP` Properties, `CAL` Calendar, `RES` Reservations, `INB` Inbox, `AUT` Automations, `TSK` Tasks, `X` cross-cutting.
- Priority: **P0** = MVP launch blocker, **P1** = needed within 3 months of launch, **P2** = later.
- "Listing" and "property" mean the same thing: one bookable unit or a parent of bookable units.
- All dates are stored as local dates in the listing's timezone; all timestamps in UTC.
- Money is stored as integer minor units (cents) plus ISO currency code.

## Module 1 — Properties

Properties hold everything that describes a bookable unit and the defaults every other module inherits: timezone, check-in/out times, capacity, base price and booking rules.

### User stories

- As a manager, I add a new apartment once and reuse its details on every channel.
- As a manager of an aparthotel, I group 10 identical studios under one parent so I price and describe them once.
- As a manager, I tag listings ("Amsterdam", "Owner: Jansen", "Pool") so automations and filters target groups, not single units.
- As a cleaner supervisor, I see each unit's cleaning status before a guest arrives.

### Listing types

| Type | Bookable | Description |
| --- | --- | --- |
| Single unit | Yes | One apartment or house |
| Multi-unit (parent) | Yes, via allotment | Group of identical sub-units sharing content, price and rules; a booking is assigned to one free sub-unit |
| Sub-unit | Indirectly | A physical unit inside a multi-unit; holds its own availability and cleaning status |
| Complex | No | Container for single units and multi-units at one address (building, hotel); shared content and reporting only |

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| PRP-01 | Create, edit, duplicate and archive a listing. Archived listings keep history and cannot take new bookings. | P0 |
| PRP-02 | Core fields: internal name, public title, type, status (draft, active, archived), address with geo-coordinates, timezone (derived from address, editable), currency. | P0 |
| PRP-03 | Capacity: max guests, bedrooms, beds by type, bathrooms (full/half), size in sq ft. | P0 |
| PRP-04 | Amenities from a fixed master list mapped to OTA codes, plus free-text custom amenities. | P0 |
| PRP-05 | Descriptions in multiple languages: summary, space, neighbourhood, transit, house rules, access notes; per-field character counters showing OTA limits. | P0 |
| PRP-06 | Photos: upload (JPEG/PNG/HEIC, up to 25 MB), reorder by drag, caption, assign to room; first photo is cover; auto-generate resized variants. | P0 |
| PRP-07 | Default times: check-in from/to, check-out by; used by calendar, automations and tasks. | P0 |
| PRP-08 | Booking defaults: base nightly price, weekend price, min/max nights, advance notice (hours), preparation time (nights), booking window (days ahead), instant book vs request. | P0 |
| PRP-09 | Fees and taxes: cleaning fee, extra-guest fee (above N guests), pet fee, tourist tax (per person per night, % of stay, or fixed). Defined on the listing, snapshotted onto reservations. | P0 |
| PRP-10 | Cancellation policy selected from a list (flexible, moderate, strict, non-refundable, custom). | P1 |
| PRP-11 | Tags: free-form, many per listing, used by filters, bulk actions and automation conditions. | P0 |
| PRP-12 | Custom fields: account-defined fields (text, number, date, dropdown, secret) per listing, usable as message variables (e.g. door code, Wi-Fi password). Secret fields are masked in UI. | P0 |
| PRP-13 | Multi-unit: create a parent, add/remove sub-units, move a sub-unit between parents, convert a sub-unit back to a single unit. Content and price edited on the parent; availability and cleaning status per sub-unit. | P0 |
| PRP-14 | Complexes: group listings; complex-level content can be pushed to members. | P2 |
| PRP-15 | Bulk edit across selected listings: price, min nights, fees, tags, default times, amenities (add/remove). | P1 |
| PRP-16 | Cleaning status per unit (clean, dirty, inspected, in progress), editable manually and by tasks. | P0 |
| PRP-17 | Channel links panel (read-only in this scope): which channels a listing is connected to, sync mode and last sync time. | P0 |
| PRP-18 | Listing completeness score showing missing fields required by each channel before publishing. | P2 |
| PRP-19 | Change log per listing: field, old value, new value, user, timestamp. | P0 |

### Screens

1. **Property list** — table with photo, name, type, city, tags, status, cleaning status, channels; filters by tag, city, type, status; search; multi-select for bulk actions.
2. **Property editor** — tabs: Overview, Location, Rooms and beds, Amenities, Descriptions, Photos, Booking rules, Fees and taxes, Custom fields, Channels, Log. Autosave per tab with unsaved-change warning.
3. **Multi-unit view** — parent header plus sub-unit list with per-unit cleaning status and next arrival.
4. **Create wizard** — type, address, capacity, photos, base price; minimum to make a listing bookable in under 5 minutes.

### Business rules

- A listing can't be activated without address, timezone, capacity, base price, check-in/out times and at least one photo.
- Changing timezone on a listing with future reservations requires confirmation and shows affected bookings.
- Archiving a listing with future confirmed reservations is blocked until they are moved or cancelled.
- Price and rule changes apply to future dates only; existing reservations keep their snapshotted price.

### Acceptance criteria

- A new single unit can be created and made bookable in under 5 minutes using the wizard.
- Editing a multi-unit parent's base price updates all sub-units' future calendar prices within 5 seconds.
- A custom field marked secret never appears in exports or logs in plain text.

## Module 2 — Calendar

The calendar stores one record per listing per night and answers one question with certainty: can this listing be booked for these dates, and at what price? It is the only component allowed to change availability.

### User stories

- As a manager, I see all units for the next 30 days on one screen and spot gaps instantly.
- As a manager, I block a unit for maintenance from Monday to Thursday and every channel closes those nights.
- As a manager, I raise prices for a festival weekend on 20 units in one action.
- As a manager, I add a 1-night preparation buffer so cleaners always have a day between stays.

### Calendar day model

Each listing-night holds: date, price, min nights, max nights, closed-to-arrival (CTA), closed-to-departure (CTD), status (available, booked, blocked), a set of block reasons, and references to whatever causes each block. For multi-units, the parent also holds allotment = number of free sub-units.

| Block reason | Source | Removable by user |
| --- | --- | --- |
| Reservation | Confirmed or Reserved booking | No — change the reservation |
| Manual block | User action, with a note (maintenance, personal use) | Yes |
| Owner stay | Owner reservation | Via reservation |
| iCal import | External calendar event | No — changes on next import |
| Preparation time | Derived N nights before/after a booking | No — change setting |
| Advance notice | Derived from listing setting and current time | No |
| Booking window | Derived: beyond N days ahead | No |
| Default closed | Listing set to closed unless opened | Yes |

Status is derived: a night is **available** only when it has no block reasons (or allotment > 0 for multi-units).

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| CAL-01 | Generate calendar days for every active listing for at least 730 days ahead; extend daily. | P0 |
| CAL-02 | Availability check API: given listing, check-in, check-out and guests, return bookable yes/no with the failing rule (blocked night, min nights, CTA, CTD, capacity, advance notice, window). | P0 |
| CAL-03 | Atomic hold: reserving dates locks all affected nights in one transaction; a concurrent request for any overlapping night fails. | P0 |
| CAL-04 | Price per night with overrides by date range; base price from the listing when no override. Display whether a value is base or overridden. | P0 |
| CAL-05 | Price quote: total for a stay = sum of nightly prices + fees + taxes − length-of-stay discounts (weekly, monthly %), returned as itemised lines. | P0 |
| CAL-06 | Min/max nights, CTA and CTD per date range; min nights evaluated on the arrival night. | P0 |
| CAL-07 | Manual block and unblock for a date range, with reason and note, on one or many listings. | P0 |
| CAL-08 | Preparation time: auto-block N nights before and/or after each reservation; recalculated when a reservation moves. | P1 |
| CAL-09 | iCal export URL per listing (availability only, no guest data). | P0 |
| CAL-10 | iCal import: subscribe to external URLs per listing, poll every 15 minutes, convert events into blocks, show last import result and errors. | P0 |
| CAL-11 | Multi-unit allotment: parent availability = count of available sub-units; a booking on the parent auto-assigns a sub-unit, reassignable by drag. | P0 |
| CAL-12 | Bulk update across listings and date ranges: price (set, +/- amount, +/- %), min nights, CTA/CTD, open/close. Preview affected nights before applying. | P0 |
| CAL-13 | Change log per night: field, old, new, source (user, automation, channel, pricing tool), timestamp. | P0 |
| CAL-14 | Emit `calendar.updated` events with listing and date range after every change, batched per transaction. | P0 |
| CAL-15 | Accept rate and availability updates from an external dynamic-pricing tool through the API, with source recorded. | P1 |
| CAL-16 | Gap rules: optionally lower min nights for orphan gaps shorter than min nights. | P2 |

### Screens

1. **Multi-calendar** — rows = listings (grouped by complex/multi-unit, collapsible), columns = days. Reservation bars coloured by channel and labelled with guest name and nights. Each empty cell shows price and min nights. Blocks show as hatched cells with reason icon. Sticky listing column and date header; scroll horizontally by day, jump to date, zoom (week, 2 weeks, month).
2. **Interactions on the grid** — drag across empty cells on one row to open a menu: create reservation, create quote, block, edit price/min nights. Click a bar to open the reservation side panel. Drag a bar to another row to relocate (with availability check and confirmation). Filters by tag, city, type, availability on a date.
3. **Single-listing calendar** — month view with the same data, plus rule summary for the listing.
4. **Bulk edit panel** — select listings and date range, choose fields, preview count of nights changed, apply.
5. **iCal settings** — per listing: export URL (copy, regenerate), import feeds with status.

### Business rules

- A night cannot carry two reservation blocks. Overlap attempts fail with an error naming the conflicting reservation.
- Check-out day is not a booked night: a stay of 10–13 May blocks nights 10, 11 and 12.
- Price edits never change prices already snapshotted on reservations.
- iCal-imported blocks that disappear from the feed are removed on the next successful import; a failed import keeps existing blocks.
- All dates are evaluated in the listing's timezone, including advance notice cut-offs.

### Acceptance criteria

- 1,000 concurrent booking attempts on the same night result in exactly one success.
- Multi-calendar loads 50 listings × 31 days in under 1.5 seconds.
- A manual block on 20 listings appears on the grid and emits events within 3 seconds.

## Module 3 — Reservations

A reservation is the central record that ties a guest, a listing, dates and money together; every other module reacts to its status changes. It follows a strict status machine and is never deleted.

### User stories

- As a manager, I take a phone booking and create it manually with the right price in under a minute.
- As a manager, I send a guest a quote that holds nothing until they accept it.
- As a manager, I approve or decline request-to-book bookings before they expire.
- As a manager, I extend a guest's stay by two nights and see the new total before confirming.
- As front office, I mark a guest as checked-in or no-show.

### Status machine

| Status | Blocks calendar | Entered when | Can move to |
| --- | --- | --- | --- |
| Inquiry | No | Guest asks a question, or user creates an inquiry/quote | Reserved, Confirmed, Closed |
| Reserved | Yes (time-limited) | Request to book arrives, or quote held | Confirmed, Declined, Expired |
| Confirmed | Yes | Instant book, approval, accepted quote, manual confirm | Canceled |
| Declined | No | Host declines a request | — (final) |
| Expired | No | Reserved not approved before deadline (default 24 h) | — (final) |
| Closed | No | Inquiry not converted, or check-in date passed | — (final) |
| Canceled | No | Host or guest cancels a confirmed booking | — (final) |

**Stay status** is separate and applies only to Confirmed: upcoming → checked-in → checked-out, or no-show.

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| RES-01 | Create a manual reservation from the calendar or reservation list: listing, dates, guests (adults, children, infants, pets), guest record (search or create), source, status, price (calculated by CAL-05, overridable with reason). | P0 |
| RES-02 | Ingest reservations from channels and the booking engine through one internal interface: create, modify, cancel; idempotent on channel + external confirmation code. | P0 |
| RES-03 | Enforce the status machine; reject illegal transitions with a clear error. Final statuses are immutable except notes and tags. | P0 |
| RES-04 | Approval deadline for Reserved: configurable per source; countdown shown in list and inbox; auto-expire job frees the calendar and notifies the user. | P0 |
| RES-05 | Quotes: create one or more priced options for a guest (different listings or dates), share a link, optional hold, expiry date; accepting converts to Confirmed after availability re-check. | P1 |
| RES-06 | Alterations on Confirmed: change dates (extend/shorten), change guests count, relocate to another listing. Each shows a before/after price diff and requires confirmation; runs availability check atomically. | P0 |
| RES-07 | Cancellation: by host or guest, with reason; applies the snapshotted cancellation policy to compute refund due; frees nights; never deletes. | P0 |
| RES-08 | Money breakdown snapshotted at booking: nightly rates, fees, taxes, discounts, channel commission, host payout, guest total. Edits create adjustment lines, never overwrite. | P0 |
| RES-09 | Folio: list of invoice items (accommodation, fees, taxes, extras, adjustments) and recorded payments; balance due. | P0 |
| RES-10 | Record payments received outside the system (cash, bank transfer, channel-collected) against the folio. | P0 |
| RES-11 | Stay status updates: check-in, check-out, no-show; ETA and ETD fields editable. | P0 |
| RES-12 | Guest record: name, email, phone, language, nationality, notes, tags; linked reservations history; merge duplicates. | P0 |
| RES-13 | Reservation list with saved views and filters: status, stay status, listing, tag, source, check-in/out range, created date, balance due; export to CSV. | P0 |
| RES-14 | Global search by confirmation code, guest name, email, phone. | P0 |
| RES-15 | Group reservation: one booker, multiple listings, shared folio. | P2 |
| RES-16 | Owner stay: reservation type that blocks the calendar with no price, flagged for owner reporting. | P1 |
| RES-17 | Internal notes and attachments on a reservation. | P0 |
| RES-18 | Activity log: every status change, alteration, price change, message and task with actor and timestamp. | P0 |
| RES-19 | Emit `reservation.created`, `reservation.updated`, `reservation.status_changed`, `reservation.dates_changed` events. | P0 |

### Screens

1. **Reservation list** — table: code, guest, listing, check-in, check-out, nights, guests, source, status, stay status, total, balance due. Quick tabs: Arriving today, Departing today, In house, Pending approval, Upcoming.
2. **Reservation page** — header (guest, dates, listing, status, source, action menu); tabs: Overview, Guest, Financials (breakdown + folio), Messages (embedded inbox thread), Tasks, Notes and files, Activity log.
3. **Reservation side panel** — opened from calendar or inbox: summary, status actions, quick links.
4. **Create reservation / quote dialog** — listing and dates prefilled from calendar selection, live price calculation, availability warnings.
5. **Alteration dialog** — new dates or listing, before/after comparison, confirm.
6. **Today view (home)** — arrivals, departures, pending approvals, unpaid balances.

### Business rules

- A Confirmed reservation can't go back to Inquiry or Reserved.
- Changes to a channel reservation made in the PMS are only allowed where the channel supports them; otherwise the UI explains that the change must happen on the channel.
- Channel-originated money fields are read-only; differences are recorded as adjustments.
- A reservation whose check-out has passed by 30 days locks its financial lines (editable only with an adjustment reason).

### Acceptance criteria

- A duplicate channel webhook for the same booking creates exactly one reservation.
- Extending a stay into a blocked night fails without changing anything.
- Every status transition in the table is covered by an automated test; every illegal transition is rejected.

## Module 4 — Unified Inbox

The inbox puts every guest conversation from every channel into one feed, threaded by guest and reservation, so a small team can answer fast without switching apps. Replies go back out through the channel the guest wrote on.

### User stories

- As a manager, I see all unanswered guest messages across Airbnb, Booking.com and email in one list, oldest first.
- As a manager, I reply with the reservation, door code and check-in time visible next to the thread.
- As a team, we assign a conversation to a colleague and see who is handling what.
- As a manager, I get an AI-drafted reply that I edit and send.

### Channels

| Channel | Direction | MVP | Notes |
| --- | --- | --- | --- |
| Email | In and out | P0 | Per-account inbound address plus forwarding; outbound from a verified domain |
| Airbnb messages | In and out | P2 | Depends on Airbnb API connection |
| Booking.com messages | In and out | P0 | Depends on Booking.com connection |
| Vrbo messages | In and out | P2 | Depends on Vrbo connection |
| SMS | In and out | P1 | Via a provider (e.g. Twilio, MessageBird) |
| WhatsApp Business | In and out | P2 | Template rules for messages outside the 24-hour window |
| Internal notes | Internal only | P0 | Never sent to the guest |

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| INB-01 | Conversation list with: guest name, listing, dates, status chip, channel icon, last message preview, time since last guest message, assignee, unread marker. | P0 |
| INB-02 | Threading: one conversation per guest per reservation; inquiries without a reservation start a conversation that attaches when the booking is created. | P0 |
| INB-03 | Filters and tabs: Unanswered, Assigned to me, Pending approval, Arriving in 48 h, In house, Done; by channel, listing, tag. | P0 |
| INB-04 | Reply composer: send through the originating channel by default, switch channel where available, attachments (images, PDF), emoji, character count against channel limits. | P0 |
| INB-05 | Saved replies: account library with title, body, variables, language variants; insert via `/` shortcut and search. | P0 |
| INB-06 | Variables resolved at send time from guest, reservation, listing and custom fields (e.g. `{{guest.first_name}}`, `{{listing.wifi_password}}`); preview shows resolved text; unresolved variables block sending. | P0 |
| INB-07 | Context panel: reservation summary with status actions (approve, decline), guest profile and history, listing quick info and custom fields, scheduled and sent auto-messages, tasks for this stay. | P0 |
| INB-08 | Assignment: assign to a user, reassign, unassigned queue; mark conversation done; it reopens on a new guest message. | P0 |
| INB-09 | Internal notes inside the thread, visually distinct, with @mentions that notify the colleague. | P1 |
| INB-10 | Delivery status per outbound message: queued, sent, delivered, failed with reason; retry action on failure. | P0 |
| INB-11 | AI reply draft: generate a suggested reply from thread, reservation and listing knowledge (descriptions, house rules, custom fields); never sends automatically in MVP. | P1 |
| INB-12 | Auto-translate: show guest messages translated to the user's language and translate replies into the guest's language, with original visible. | P2 |
| INB-13 | Response-time metric per conversation and per user (time from guest message to first reply). | P1 |
| INB-14 | Full-text search across messages. | P1 |
| INB-15 | Real-time updates (new messages appear without reload) and browser/mobile push notifications for new guest messages. | P0 |
| INB-16 | Emit `message.received` and `message.sent` events for automations and webhooks. | P0 |

### Screens

1. **Inbox** — three columns: conversation list (left), thread with composer (centre), context panel (right). Collapses to two columns on tablet and a single stacked view on mobile.
2. **Saved replies manager** — list, editor with variable picker and preview against a sample reservation.
3. **Message log** — admin view of outbound messages with delivery status, for troubleshooting.

### Business rules

- A message received on a channel is stored even if the reservation is unknown; it is matched later.
- Outbound messages respect channel rules (e.g. no contact details or external links where the OTA forbids them); the composer warns before sending.
- Messages are never edited or deleted after sending; a failed message can be retried or discarded.
- Guest personal data in messages follows the GDPR retention policy (see cross-cutting).

### Acceptance criteria

- A guest email reply lands in the correct thread within 30 seconds.
- A reply with an unresolved variable cannot be sent.
- A new guest message on a conversation marked Done moves it back to Unanswered.

## Module 5 — Automations

Automations turn reservation events into scheduled actions — messages and tasks in MVP — so a manager configures the guest journey once and it runs for every booking. They are rules of the form **trigger + offset + conditions → action**, scheduled per reservation and kept in sync as reservations change.

### User stories

- As a manager, I send a booking confirmation immediately, check-in instructions 2 days before arrival at 10:00, and a review request 1 day after check-out.
- As a manager, I send different check-in instructions to my Amsterdam and Rotterdam units using tags.
- As a manager, I see exactly which messages are scheduled for a reservation and can skip one.
- As a manager, when a guest changes dates, their scheduled messages move with them.

### Rule anatomy

| Part | Options (MVP) |
| --- | --- |
| Trigger | Reservation confirmed; reservation canceled; reservation dates changed; check-in date; check-out date; reservation created (any status); message received (P1); task completed (P1) |
| Offset | Immediately, or N minutes/hours/days before or after the trigger; optional fixed local time ("2 days before check-in at 10:00") |
| Conditions | Listings or tags (include/exclude); source/channel; status; nights (≥/≤); number of guests; guest language; days between booking and check-in; custom field values |
| Action | Send message (to guest, owner, team member, or email address) via a chosen channel with fallback order; create task from template (see Module 6) |
| Content | Template with variables and language variants; chooses variant by guest language, falls back to default |

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| AUT-01 | Create, edit, duplicate, pause and delete automation rules; name for internal use. | P0 |
| AUT-02 | On activation, schedule the action for all matching reservations whose run time is in the future; skip past times. | P0 |
| AUT-03 | On any reservation change (dates, ETA/ETD, listing, status, guests), re-evaluate every rule for that reservation: reschedule, cancel or create jobs as needed. | P0 |
| AUT-04 | Time anchors use reservation ETA/ETD when set, else the listing default check-in/out time, in the listing timezone. | P0 |
| AUT-05 | Cancellation of a reservation cancels all its pending jobs, except rules triggered by cancellation. | P0 |
| AUT-06 | Per-reservation automation timeline: scheduled, sent, skipped, failed jobs with times; actions to skip, send now, or edit a single instance. | P0 |
| AUT-07 | Idempotency: a rule fires at most once per reservation per trigger occurrence, even across retries and restarts. | P0 |
| AUT-08 | Channel selection with fallback (e.g. OTA message → email → SMS) when the preferred channel is unavailable for that reservation. | P1 |
| AUT-09 | Message expiry: optional "don't send if later than N hours past scheduled time" to avoid stale messages after outages. | P1 |
| AUT-10 | Test mode: preview the resolved message for any reservation and send a test to yourself. | P0 |
| AUT-11 | Library of starter rules (confirmation, check-in instructions, mid-stay check, check-out reminder, review request, cleaner notification) the user can enable in one click. | P1 |
| AUT-12 | Rule change history (who changed what, when). | P1 |
| AUT-13 | Execution log across all rules with filters (rule, status, date), for troubleshooting. | P0 |
| AUT-14 | Rate limiting per guest: no more than N automated messages per guest per hour (default 3). | P1 |
| AUT-15 | Future actions (P2): auto-approve request-to-book by conditions, send review on OTA, update cleaning status, call webhook. | P2 |

### Screens

1. **Automations list** — rules with trigger summary, conditions summary, action, status (active/paused), last run, count scheduled.
2. **Rule builder** — step form: When (trigger + offset + time), For which bookings (conditions), Do what (action), Content (template editor with variable picker and language tabs), Review (sample reservation preview + count of reservations it will apply to).
3. **Reservation automation timeline** — panel inside the reservation page and inbox context panel.
4. **Execution log** — admin table.

### Business rules

- A rule edit applies to jobs not yet executed; already-sent messages are untouched.
- Pausing a rule cancels its pending jobs; resuming re-schedules future ones per AUT-02.
- A job whose template references a variable that resolves to empty fails visibly instead of sending a broken message.
- Scheduler precision: jobs run within 60 seconds of their scheduled time.

### Acceptance criteria

- Moving a reservation's check-in by 3 days moves all check-in-relative jobs by 3 days within 30 seconds.
- Restarting the scheduler during a burst sends no duplicate messages.
- Activating a rule on an account with 500 future reservations schedules all matching jobs within 2 minutes.

## Module 6 — Tasks

Tasks schedule and track the physical work behind each stay — cleaning, inspections, maintenance, linen — and give field staff a simple mobile view to do it. Most tasks are generated by reservations; the rest are recurring or ad hoc.

### User stories

- As a manager, every checkout automatically creates a turnover clean for that unit, due before the next check-in.
- As a cleaner, I open my phone, see today's jobs in order, tick the checklist, add photos and mark done.
- As a supervisor, I see unassigned and overdue tasks and fix them before guests arrive.
- As a maintenance worker, I log a broken item and it becomes a task for the right person.

### Task types and sources

| Source | Example | Created by |
| --- | --- | --- |
| Reservation-triggered (auto-task) | Turnover clean on check-out day | Automation rule (Module 5) using a task template |
| Recurring (calendar-based) | Monthly deep clean, weekly pool service | Recurrence rule on listings |
| Manual | Fix leaking tap, deliver extra towels | User, optionally linked to a reservation |
| Reported issue | Cleaner reports broken lamp | Mobile app, converted to task |

### Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| TSK-01 | Task fields: title, type (cleaning, inspection, maintenance, other), listing, optional reservation, planned start, due by, estimated duration, priority, assignee (user or group), supervisor, status, description, checklist, attachments, cost (P1). | P0 |
| TSK-02 | Statuses: open → assigned → in progress → done, plus canceled; record actual start and end when the assignee taps start/finish. | P0 |
| TSK-03 | Task templates: reusable title, type, checklist, duration, default assignee/group, instructions, required photos. | P0 |
| TSK-04 | Auto-tasks: template + trigger + offset + conditions (via Module 5). Due-by defaults to next check-in on that unit, or end of day if none. | P0 |
| TSK-05 | Reservation changes update linked auto-tasks: date change moves the task, cancellation cancels it (unless already in progress or done, which flags it for review). | P0 |
| TSK-06 | Same-day turnover flag: highlight tasks where check-out and next check-in fall on the same day. | P0 |
| TSK-07 | Group assignment: task visible to all group members; first to accept owns it. | P1 |
| TSK-08 | Recurring tasks: repeat daily/weekly/monthly on selected listings, with end date. | P1 |
| TSK-09 | Checklist items with optional required photo; task can't be completed until required items are ticked. | P0 |
| TSK-10 | Completion side effects: set unit cleaning status (e.g. turnover done → clean; inspection done → inspected); optionally create a follow-up task (e.g. inspection after cleaning). | P0 |
| TSK-11 | Notifications to assignee: new task, change in time, cancellation; daily digest of tomorrow's tasks. | P0 |
| TSK-12 | Issue reporting from mobile: photo, description, listing → creates a maintenance task for the supervisor to assign. | P1 |
| TSK-13 | Task list with filters: date range, status, assignee (incl. unassigned), supervisor, listing, tag, city, type, overdue; saved views; CSV export. | P0 |
| TSK-14 | Task board / schedule view: per day per assignee, drag to reassign or reschedule. | P1 |
| TSK-15 | External cleaner access: invite with role limited to their tasks, no guest personal data beyond first name and guest count. | P0 |
| TSK-16 | Task history log and comments thread. | P0 |
| TSK-17 | Emit `task.created`, `task.updated`, `task.completed` events. | P0 |

### Screens

1. **Tasks list (web)** — table with date, listing, type, title, assignee, status, due, same-day flag; quick tabs Today, Tomorrow, Unassigned, Overdue.
2. **Task detail** — fields, checklist with progress, photos, comments, linked reservation (arrival/departure, guest count, next guest), history.
3. **Schedule view** — columns = assignees, rows = time, for one day.
4. **Templates manager** — list and editor.
5. **Mobile staff app (PWA)** — My tasks today (ordered by due time), task screen with big start/finish buttons, checklist, camera upload, unit access info (door code shown only during the task window), report issue.

### Business rules

- A task linked to a reservation shows the next guest's check-in time and guest count, so cleaners prepare the right number of beds.
- Door codes and access info are visible to assignees only between planned start minus 2 hours and task completion.
- A unit with an incomplete turnover task 2 hours before the next check-in raises an alert to the supervisor.
- Completed tasks are read-only except comments.

### Acceptance criteria

- A new confirmed reservation creates its turnover task within 30 seconds, due before the following check-in.
- Cancelling a reservation cancels its open auto-tasks and notifies assignees.
- The mobile view works offline for checklist ticking and syncs when back online (P1).

## Cross-cutting requirements

These apply to all six modules; most are P0 because they are expensive to retrofit.

### Roles and permissions

| Role | Properties | Calendar | Reservations | Inbox | Automations | Tasks |
| --- | --- | --- | --- | --- | --- | --- |
| Admin | Full | Full | Full | Full | Full | Full |
| Manager | Edit | Edit | Full | Full | Edit | Full |
| Front office | View | Block only | Create, edit, no cancel | Full | View | Create, assign |
| Supervisor | View | View | View (no money) | View | None | Full on own team |
| Cleaner / field staff | Own tasks' units | None | Next guest summary only | None | None | Own tasks only |

| ID | Requirement | Priority |
| --- | --- | --- |
| X-01 | Role-based permissions as above, plus listing scope (a user can be limited to tags or listings). | P0 |
| X-02 | Authentication: email + password, magic link, optional TOTP 2FA (mandatory for Admin); SSO later (P2). | P0 |
| X-03 | Audit log for every create/update/delete across modules: actor (user, automation, channel, API), entity, diff, timestamp, IP. Retained 2 years. | P0 |
| X-04 | Domain events for every state change (listed per module) on an internal bus; outbound webhooks with HMAC signature, retries with exponential backoff for 24 h, delivery log. | P0 |
| X-05 | Public REST API covering the same entities, OAuth2 client credentials, rate limit 15 req/s per account, cursor pagination, idempotency keys on POST. | P1 |
| X-06 | Notifications centre: in-app, email and push; per-user preferences by type. | P0 |
| X-07 | UI in English only; guest-facing templates in any language. | P0 |
| X-08 | Global search across listings, reservations, guests, tasks. | P0 |
| X-09 | CSV export of any list view; CSV import for listings and reservations (migration from another PMS). | P0 |

### Non-functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| X-10 | US privacy (CCPA/CPRA and other state laws): US data residency (Supabase US region), guest data export and erasure on request (anonymise, keep financial records as legally required), configurable retention for guest messages and IDs. | P0 |
| X-11 | Availability 99.9% monthly for the calendar and reservation APIs; scheduled maintenance outside 02:00–05:00 US Eastern. | P0 |
| X-12 | Performance: p95 page load < 2 s for list views up to 10,000 rows (paginated); p95 API < 300 ms for reads. | P0 |
| X-13 | Scale target for year one: 500 accounts, 10,000 listings, 1 million reservations, 10 million calendar days. | P0 |
| X-14 | Backups: point-in-time recovery for 14 days; restore tested quarterly. RPO 5 min, RTO 4 h. | P0 |
| X-15 | Security: encryption in transit (TLS 1.2+) and at rest; secrets (door codes, API keys) encrypted at field level; OWASP top-10 review before launch. | P0 |
| X-16 | Observability: structured logs, metrics and alerts on sync failures, scheduler lag (> 2 min), webhook failure rate, double-booking guard rejections. | P0 |
| X-17 | Responsive web for all manager screens; mobile-first PWA for field staff. | P0 |
| X-18 | Accessibility: WCAG 2.1 AA for core screens. | P1 |

## Open questions

Decisions taken on 21 Nov 2026 are in the table; the remaining questions are below it.

| Topic | Decision |
| --- | --- |
| Goal of this phase | Technical trial: prove the core can be built; no pilot customers yet |
| Target customer | Small US short-term-rental managers (5–50 units) |
| Main migration source | Guesty |
| Channel | Booking.com only, via direct Connectivity API |
| Multi-units | In MVP (P0) |
| Pricing engine | Base nightly price + date-range overrides + weekly/monthly discounts (CAL-04, CAL-05); one rate per listing pushed to Booking.com; no rate plans (refundable vs non-refundable) in this phase |
| AI reply drafts | Not in this phase |
| Staff app | Responsive web app / PWA only |
| UI language | English only |
| Tourist / occupancy tax | Skipped |
| Payments | Not in MVP |
| Business model | Not defined yet |
| Tech stack | Next.js + Supabase, hosted on Vercel |
| Builder | Omri, with Claude Code |
| Timeline / budget | None set |

- [ ] **Booking.com API access:** confirm how to get Connectivity API credentials and test properties before becoming a certified partner.
- [ ] **Channel fit:** Booking.com carries less US vacation-rental demand than Airbnb and Vrbo; acceptable for a technical trial, revisit before targeting real customers.

**Out of scope for this document:** channel manager integrations, payments and payment schedules, guest app and check-in forms, direct booking website, owner portal and accounting, reporting and analytics. Each gets its own requirements doc.
