# Step 7 — Automations (AUT-*)

Rules of the form **trigger + offset (+ fixed local time) + conditions → action**, scheduled per
reservation as jobs and kept in sync as reservations change. Requirements: `docs/requirements.md`
Module 5. Migration `20261126001000_automations.sql`.

## Scope

| ID | Done in this step |
| --- | --- |
| AUT-01 | Create, edit, duplicate, pause/resume, delete (soft: `deleted_at`) rules |
| AUT-02 | Activating / editing / resuming a rule schedules jobs for matching reservations whose run time is in the future |
| AUT-03 | A trigger on `reservations` re-evaluates every active rule of the account in the same transaction: reschedule, cancel or create |
| AUT-04 | Check-in/out anchors: ETA/ETD, else the listing (parent for sub-units) default times, in the listing timezone |
| AUT-05 | Cancel/decline/expire/close cancels pending jobs, except rules triggered by cancellation |
| AUT-06 | Reservation **Automations** tab: scheduled/sent/skipped/failed/canceled jobs; skip, send now, edit this message |
| AUT-07 | `unique (rule_id, reservation_id, occurrence)` + leased claiming + a status check when completing |
| AUT-09 | Optional "don't send more than N hours late" (`expire_after_hours`) |
| AUT-10 | Builder preview against any reservation + count of reservations it applies to; send a test to yourself |
| AUT-11 | Starter library (confirmation, check-in instructions, mid-stay check, check-out reminder, review request) |
| AUT-12 | Rule changes are audited (audit log, filtered per rule in the builder) |
| AUT-13 | Execution log across rules with filters |

Not in this step: create-task action (needs Tasks, step 8), AUT-08 channel fallback (email is the
only channel), AUT-14 per-guest rate limit, message-received / task-completed triggers (P1),
custom-field conditions, AUT-15.

## Model

- `automation_rules`: `trigger` (`reservation_created`, `reservation_confirmed`, `reservation_canceled`,
  `dates_changed`, `check_in`, `check_out`), `offset_minutes` (signed; negative = before),
  optional `at_time` (then the offset is whole days), `conditions` jsonb, `action` jsonb,
  `expire_after_hours`, `status` active/paused, `deleted_at`.
- Conditions: listing ids / tags (include, exclude), sources, min/max nights, min/max guests, guest
  languages, min/max days between booking and check-in. Owner stays never match.
- Actions: `message` to the guest (into the reservation's conversation, author `automation`, sent
  by the inbox outbox) or to a fixed email address (direct email); `agent_draft`: the AI agent
  drafts a reply into the approval queue (the "ask the agent" action; needs `ANTHROPIC_API_KEY`).
  Message content has language variants chosen by guest language.
- `automation_jobs`: one per rule × reservation × occurrence (`check_in`, `check_out`,
  `reservation_confirmed`, …; `dates_changed:<epoch>` for repeatable events). Status
  scheduled → running → sent | failed | skipped; scheduled → canceled | skipped.

## Execution

`/api/internal/automations/run` (cron secret) claims due jobs with a lease, renders the template
(unresolved variables fail the job visibly), and completes it through
`public.complete_automation_job`, which writes the message and marks the job in one transaction.
"Send now" runs the job immediately. On Hobby the schedule runs every 15 minutes; the requirement's
60-second precision needs the every-minute schedule on Pro (TODO.md).
