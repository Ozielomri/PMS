# TODO

## Checklist (updated 23 Nov 2026)

Detailed steps for each item are in the sections below.

### Now (production needs these)

- [ ] Add `SUPABASE_SECRET_KEY` to Vercel (sensitive, Production + Preview), then redeploy. Every background job fails without it. Steps: "Add SUPABASE_SECRET_KEY to Vercel".
- [ ] Merge PR #7 (schedules + step 7 Automations). The automations migration is already applied to Supabase.

### API keys and secrets

There is no OpenAI integration: the AI features use Anthropic (`ANTHROPIC_API_KEY`). Adding OpenAI would mean a second provider adapter and the same privacy agreement.

| Key | Used for | Source | Status |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Everything | Supabase | Set |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Everything | Supabase | Set |
| `PMS_ENCRYPTION_KEY` | Encrypted secrets (iCal feeds, door codes) | Generated | Set (sensitive) |
| `CRON_SECRET` | Scheduled workers | Generated | Set (sensitive) |
| `SUPABASE_SECRET_KEY` | All workers | Supabase → API Keys → Secret keys | **Missing** |
| `POSTMARK_SERVER_TOKEN` | Actually emailing guests | Postmark → Server | Missing (optional until real email) |
| `INBOX_WEBHOOK_SECRET` | Inbound guest email and delivery receipts | Generate a random value | Missing (with Postmark) |
| `INBOX_EMAIL_FROM`, `INBOX_INBOUND_DOMAIN` | Sender address and reply domain (not secret) | Your email domain | Missing (with Postmark) |
| `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`) | AI reply drafts, agent, "ask the agent" automations | Anthropic Console (set a spend limit) | Missing: only after the privacy item |
| `NEXT_PUBLIC_SITE_URL` | Links in emails and invitations | Production URL | Missing (falls back to the Vercel URL) |
| `NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS=on` | Resized photos | Supabase Pro | Off (optional) |
| Booking.com Connectivity API credentials + test property | Step 9 | Booking.com Connectivity partner program | Not started: apply early, approval takes time |
| VAPID keys | Browser and phone push (later) | Generated | Later |

### Accounts and setup

- [ ] Privacy (CCPA): data agreement with Anthropic and a privacy policy update, before any real guest data goes to the AI. Then add `ANTHROPIC_API_KEY`.
- [ ] Postmark: sending domain (DKIM, Return-Path), inbound MX record, the two webhooks, then the variables above.
- [ ] Vercel Pro (optional): every-minute schedules for messages, automations and webhooks.
- [ ] Apply for Booking.com Connectivity API access (credentials + test property).

### Build

- [ ] Signed-in visual check of the Automations screens.
- [ ] Step 8: Tasks + staff PWA (also unlocks the "create task" automation action).
- [ ] Step 9: Booking.com integration (needs the credentials above).
- [ ] Inbox follow-ups: attachments, @mention notifications, push, AI auto-replies.

## Privacy: AI provider data agreement (CCPA/CPRA)

The AI agent (`docs/plans/ai-agent.md`) sends guest data (names, messages, stay details) to the AI provider. Before any real guest data is used:

1. Sign a data processing agreement with the AI provider (service-provider terms under CCPA/CPRA; no training on our data).
2. Update the privacy policy: which guest data goes to the AI provider, for what purpose, and how long it is kept.
3. Decide what the agent may never send (e.g. secret custom fields outside check-in day) and enforce it in code.
4. Remove this item.

The inbox's "Suggest reply" (INB-11) is the first feature that sends guest data (first name, messages, stay dates, listing content; never secret custom fields, last names, emails or phones). It stays off until `ANTHROPIC_API_KEY` is set: keep it unset in Production until steps 1–3 are done.

## Inbox: connect a real email provider (step 6)

Until this is done the inbox uses the development `log` adapter: replies are stored and shown as delivered but **nothing is emailed**, and guest emails only arrive through "Simulate guest reply" or a manual call to the inbound webhook. The code supports Postmark (`src/lib/inbox/email/postmark.ts`); another provider (e.g. Resend) is one more adapter file.

1. **Postmark account** (postmarkapp.com): create a Server. Note its **Server API token**.
2. **Sending domain** (e.g. `mail.yourcompany.com`): Postmark → Sender Signatures → add the domain and create the DNS records it shows at your DNS host: **DKIM** (TXT `…._domainkey`), **Return-Path** (CNAME `pm-bounces` → `pm.mtasv.net`), and SPF/DMARC as advised. Wait for "Verified". Request account approval (Postmark reviews new accounts before you can email outside your domain).
3. **Inbound domain** (e.g. `in.yourcompany.com`): add an **MX** record `in.yourcompany.com → inbound.postmarkapp.com` (priority 10). In the Server's *Inbound* stream set **Inbound domain** = `in.yourcompany.com` and the **webhook URL** = `https://user:<INBOX_WEBHOOK_SECRET>@<your-app>/api/internal/inbox/email/inbound` (Basic auth; the user name is ignored). Tick "Include raw email content" off (not needed).
4. **Delivery webhooks**: Server → Webhooks → add `https://user:<INBOX_WEBHOOK_SECRET>@<your-app>/api/internal/inbox/email/events` for **Delivery** and **Bounce** (INB-10 delivered / failed).
5. **Vercel environment variables** (Production; mark the secrets *sensitive*): `POSTMARK_SERVER_TOKEN` (sensitive), `INBOX_WEBHOOK_SECRET` (sensitive, generate like `CRON_SECRET`), `INBOX_EMAIL_FROM` (e.g. `stays@mail.yourcompany.com`), `INBOX_INBOUND_DOMAIN` (e.g. `in.yourcompany.com`). `SUPABASE_SECRET_KEY` is needed too (sending, inbound, door-code variables for front office). Redeploy.
6. Check: `/inbox/log` shows "Postmark" and the account's inbound address (`<token>@in.yourcompany.com`); send a reply to your own address, reply to it from your mail client and see it land in the same thread within seconds.
7. Optional: guests' existing mail (e.g. `stays@yourcompany.com`) can be auto-forwarded to the account's inbound address.
8. Remove this item.

## Inbox: Anthropic API key (AI reply drafts)

1. Only after the privacy item above: create an API key in the Anthropic Console (a workspace for this app; set a monthly spend limit).
2. Add `ANTHROPIC_API_KEY` to the Vercel project as a **sensitive** variable (Production). Optionally `ANTHROPIC_MODEL` (default `claude-opus-5-5`; the agent plan suggests a cheaper model for routine replies once quality is measured).
3. Redeploy; "Suggest reply" in the composer becomes active. The per-account switch is on `/inbox/log`.
4. Remove this item.

## Inbox follow-ups

- **Browser / mobile push** for new guest messages (INB-15 second half): needs a service worker, VAPID keys and a subscription table. Live updates in open tabs work already (Realtime).
- **Attachments**: inbound attachment names and sizes are stored, the files are not; outbound attachments (images, PDF) are not built yet (INB-04).
- **@mention notifications** (INB-09): mentions are stored on the note and in the `message.note_added` event; delivering them waits for notifications (X-06).
- **Booking.com messages** (step 9): conversations and messages already have a `channel` column (`booking_com`); add an adapter like `src/lib/inbox/email/` and allow the channel in `inbox_send_message`.
- **Agent auto-replies** (ai-agent plan, trust level *auto*): not built; drafts only.

## Move to Vercel Pro and enable the every-minute schedules

The demo deployment runs on the Vercel **Hobby** plan, which allows a schedule at most every 15 minutes (with up to 15 minutes of jitter). The schedules that fit are **on** in `vercel.json`: `ical-sync` (every 15 min), `reservation-expiry` (every 15 min; every 5 on Pro), `automations-run` (every 15 min; every minute on Pro, so automated messages go out within 60 s as Module 5 requires) and `calendar-maintenance` (hourly). The workers that need every minute are **off** until Pro. Until then:

- webhook deliveries stay queued (nothing is sent);
- inbox replies whose first send attempt failed are not retried automatically (use Retry in the thread or the message log);
- internal event consumers do not run (none are registered yet);
- automated messages run every 15 minutes (with up to 15 minutes of jitter), so they can go out up to ~30 minutes after their time instead of within a minute. "Send now" on a reservation's Automations tab runs one immediately.

The running schedules need `SUPABASE_SECRET_KEY` in Vercel (see the next item); without it every run fails.

Steps:

1. Upgrade the Vercel team to **Pro**.
2. Add these to the `schedules` block in `vercel.json`, change `reservation-expiry` to `*/5 * * * *` and `automations-run` to `* * * * *`, and deploy:

```json
"webhook-dispatch": {
  "schedule": "* * * * *",
  "path": "/api/internal/webhooks/dispatch"
},
"event-consumers": {
  "schedule": "* * * * *",
  "path": "/api/internal/events/process"
},
"inbox-send": {
  "schedule": "* * * * *",
  "path": "/api/internal/inbox/send"
}
```

3. Check the runs: Vercel dashboard → project → Schedules (or `vercel schedules executions list webhook-dispatch --since 1h`).
4. Remove this item.

## Add SUPABASE_SECRET_KEY to Vercel

The workers (iCal import, expiry sweep, calendar maintenance, automations, inbox sending and inbound email, webhooks) use the Supabase secret key. `PMS_ENCRYPTION_KEY` and `CRON_SECRET` are already set.

1. Supabase → project → Project Settings → API Keys → **Secret keys** → copy the secret key (`sb_secret_…`).
2. Vercel → project `pms` → Settings → Environment Variables → Add: key `SUPABASE_SECRET_KEY`, the value, environments **Production** and **Preview**, and tick **Sensitive**.
3. Redeploy production (Deployments → latest → ⋯ → Redeploy) so the running site picks it up.
4. Remove this item.

Until then, any worker can be run by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/internal/webhooks/dispatch
```
