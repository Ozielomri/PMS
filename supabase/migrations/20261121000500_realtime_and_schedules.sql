-- Step 1: Realtime publication for domain events (the UI subscribes to the same events as
-- automations and webhooks) and the daily audit-log retention job.
-- Both are guarded so the migrations also run on plain Postgres (CI, tests).

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.domain_events';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    perform cron.schedule('pms-purge-audit-log', '17 7 * * *', 'select private.purge_audit_log()');
  end if;
end;
$$;
