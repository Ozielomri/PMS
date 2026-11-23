import { NextResponse, type NextRequest } from "next/server";

import { runAutomations } from "@/lib/automations/runner";
import { supabaseAutomationDeps } from "@/lib/automations/server";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * Step 7: runs due automation jobs (AUT-07: leased claims, so overlapping runs are safe).
 * Scheduled every 15 minutes on Hobby and every minute on Pro (scheduler precision, Module 5).
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const deps = supabaseAutomationDeps(createAdminClient({ type: "automation", id: "automations" }));
  const summary = { claimed: 0, sent: 0, failed: 0, skipped: 0, lost: 0 };
  const started = Date.now();
  // Batches until the queue is empty or ~45 s have passed.
  while (Date.now() - started < 45_000) {
    const batch = await runAutomations(deps, 25);
    for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] += batch[k];
    if (batch.claimed < 25) break;
  }
  return NextResponse.json(summary);
}

export const GET = handle;
export const POST = handle;
