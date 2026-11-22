import { NextResponse, type NextRequest } from "next/server";

import { parseKey } from "@/lib/crypto/secrets";
import { serverEnv } from "@/lib/env";
import { syncDueFeeds } from "@/lib/ical/worker";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * CAL-10: imports every due iCal feed (schedule every 15 minutes). Feeds are claimed with a
 * lease, so overlapping runs are safe; a failed feed keeps its blocks and is retried later.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  try {
    const summary = await syncDueFeeds(createAdminClient({ type: "channel", id: "ical-sync" }), {
      encryptionKey: parseKey(env.encryptionKey),
      fetch: { allowPrivateNetworks: env.webhooksAllowPrivateNetworks },
      // Worst case: one more batch after the budget (2 rounds of 15 s fetch timeouts) stays under 60 s.
      budgetMs: 25_000,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
