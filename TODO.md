# TODO

## Move to Vercel Pro and enable the schedules

The demo deployment runs on the Vercel **Hobby** plan, which allows a schedule at most every 15 minutes. The workers need every minute (webhooks, event consumers; automations later need jobs within 60 s), so the schedules are switched **off** for now. Until they are on:

- webhook deliveries stay queued (nothing is sent);
- the calendar is not extended past its initial 730+ days, and expired holds are only ignored, not swept.

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
  }
}
```

4. Check the runs: Vercel dashboard → project → Schedules (or `vercel schedules executions list webhook-dispatch --since 1h`).
5. Remove this item.

Until then, any worker can be run by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/internal/webhooks/dispatch
```

## Supabase migration history (demo project `ufsdwmlsjydfergheacs`)

The demo database was set up through the Supabase connector, so its migration history uses connector names (and the calendar migration is split into `calendar_core_part1` … `part4`) instead of the file names in `supabase/migrations/`. Before the first `npx supabase db push` to this project, align the history so the existing files are not applied twice:

```bash
npx supabase link --project-ref ufsdwmlsjydfergheacs
npx supabase migration list
npx supabase migration repair --status applied 20261121000100 20261121000200 20261121000300 20261121000400 20261121000500 20261122000100 20261122001000 20261122002100 20261122002200 20261122002300 20261122002400
```
