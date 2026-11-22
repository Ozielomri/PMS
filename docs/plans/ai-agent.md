# AI agent at the center of the PMS — plan

Decision (22 Nov 2026): the PMS gets an AI agent as a core capability. This replaces the earlier
"no AI reply drafts in this phase" decision. Status: foundations built with step 6 (role `agent`,
actor type `agent`, approval queue `agent_proposals`, reply drafts in the inbox; see
`docs/plans/step-6-inbox.md`). Trust levels, auto-sending and other tools are not built yet.

## Idea

The agent is a **member of the account with its own role**, not a replacement for the screens.
It works through the same functions the UI uses, so every rule the database enforces (no double
bookings, permission checks, append-only money, audit log, domain events) applies to it too. Hosts
keep the calendar, reservations and Today screens; the agent does much of the work in them.

## Where it pays off, in order

1. **Guest messaging** (with the Inbox, step 6): answers grounded in the listing's data and the
   reservation (check-in instructions, house rules, early check-in, late arrival). Not sure →
   hand to a human.
2. **Operations copilot:** natural-language requests ("move the Smiths to Cabin 2", "block Magnolia
   House next week", "who arrives today with a balance?"), carried out with the existing actions
   and confirmed by the host before anything changes.
3. **Proactive work:** reacts to domain events: a request near its approval deadline, an unpaid
   balance before arrival, an inquiry without a quote, a gap night.
4. **Later:** cleaning-task triage (step 8), review replies, pricing suggestions.

## Design

- **Agent identity.** A new role `agent` in the permission matrix (X-01) and actor type `agent`
  in the audit log and events (X-03, X-04), so every agent action is attributable and reviewable.
- **Tools = existing functions.** check availability, quote, create / alter / cancel reservation,
  block dates, record payment, send message, create task. Each tool has a typed schema and a
  short description; no new write paths for the agent.
- **Three trust levels per action, set per account:**
  - *auto*: the agent acts (e.g. answer an FAQ, send check-in instructions);
  - *draft*: the agent proposes, a human approves (e.g. discounts, date changes, quotes);
  - *never*: humans only (refunds, cancellations of confirmed stays, deleting anything).
  Defaults are conservative: only messaging FAQs on *auto*.
- **Approval queue.** Proposed actions are stored (who, what, why, the exact tool call) and shown
  in "Needs your attention" on Today, with approve / edit / reject. Approving runs the stored call
  as the agent, after re-checking permissions and availability.
- **Grounding.** Guest-facing answers only from listing content, custom fields and the
  reservation; the agent says when it does not know. Secret custom fields (door codes) are sent
  only under the account's rules (e.g. on check-in day).
- **Triggers.** The event bus (X-04) and the automations scheduler (step 7) wake the agent;
  "ask the agent" becomes an automation action type.
- **Models.** A cheaper, faster model for routine replies and classification; a stronger model
  for multi-step operations. Cost per account is tracked.

## Guardrails

- No action outside the agent role's permissions; the database refuses it regardless.
- Money: the agent never refunds or changes prices on *auto*.
- Every agent message and action is logged with its inputs and the model's reasoning summary.
- Rate limits per account and per guest conversation; a kill switch per account.
- Privacy (CCPA/CPRA): guest data is sent to the AI provider. Before real guest data is used, a
  data processing agreement and a privacy-policy update are needed (tracked in `TODO.md`).

## Build order impact

- **Step 5 (iCal)** stays next and unchanged: the agent needs a reliable calendar.
- **Foundations, small, can land with step 5 or 6:** `agent` role and actor type, the approval
  queue table, tool descriptions over the existing service functions.
- **Step 6 (Inbox)** becomes AI-first: drafted and auto-sent replies with the trust levels above.
- **Step 7 (Automations)** adds the "ask the agent" action and event-driven agent runs.
- **Operations copilot** after step 7, once inbox and automations exist.

## Open questions

- Which actions default to *auto* for a new account?
- Where the host talks to the copilot: a panel on every screen, or a dedicated page?
- Per-account monthly AI budget and what happens when it runs out.
