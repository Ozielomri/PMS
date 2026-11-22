# TODO

## Privacy: AI provider data agreement (CCPA/CPRA)

The AI agent (`docs/plans/ai-agent.md`) sends guest data (names, messages, stay details) to the AI provider. Before any real guest data is used:

1. Sign a data processing agreement with the AI provider (service-provider terms under CCPA/CPRA; no training on our data).
2. Update the privacy policy: which guest data goes to the AI provider, for what purpose, and how long it is kept.
3. Decide what the agent may never send (e.g. secret custom fields outside check-in day) and enforce it in code.
4. Remove this item.

## Move to Vercel Pro and enable the schedules

The demo deployment runs on the Vercel **Hobby** plan, which allows a schedule at most every 15 minutes. The workers need every minute (webhooks, event consumers; automations later need jobs within 60 s), so the schedules are switched **off** for now. Until they are on:

- webhook deliveries stay queued (nothing is sent);
- the calendar is not extended past its initial 730+ days, and expired holds are only ignored, not swept;
- requests past their approval deadline and expired quotes are only swept when someone opens the reservation list, the dashboard or the quotes page;
- iCal feeds (CAL-10) are only imported when someone presses **Sync now** (or adds the feed) in the listing's iCal tab. The `ical-sync` schedule (every 15 minutes) is allowed on Hobby, so it could be enabled on its own before the move to Pro.

Steps:

1. Upgrade the Vercel team to **Pro**.
2. Make sure `CRON_SECRET` is set in the project's environment variables (Production; it is already set for the demo). Vercel sends it as `Authorization: Bearer …`. Also add `SUPABASE_SECRET_KEY` (Supabase → Project Settings → API keys → secret key) as a **sensitive** variable: the workers need it and it is not set yet.
3. Put this block back into `vercel.json` (next to `$schema`) and deploy:

```json
"schedules": {
  "webhook-dispatch": {
    "schedule": "* * * * *",
    "path": "/api/internal/webhooks/dispatch"
  },
  "event-consumers": {
    "schedule": "* * * * *",
    "path": "/api/internal/events/process"
  },
  "calendar-maintenance": {
    "schedule": "17 * * * *",
    "path": "/api/calendar/machine/maintenance"
  },
  "reservation-expiry": {
    "schedule": "*/5 * * * *",
    "path": "/api/internal/reservations/expire"
  },
  "ical-sync": {
    "schedule": "*/15 * * * *",
    "path": "/api/internal/ical/sync"
  }
}
```

4. Check the runs: Vercel dashboard → project → Schedules (or `vercel schedules executions list webhook-dispatch --since 1h`).
5. Remove this item.

Until then, any worker can be run by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/internal/webhooks/dispatch
```
