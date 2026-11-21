import { NextResponse, type NextRequest } from "next/server";

import { processConsumer } from "@/lib/events/bus";
import { CONSUMERS } from "@/lib/events/consumers";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseEventQueueStore } from "@/lib/webhooks/supabase-store";

export const maxDuration = 60;

/** Runs every registered internal consumer once. Schedule every minute; overlapping runs are safe. */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = [];
  for (const [consumer, handler] of Object.entries(CONSUMERS)) {
    const store = supabaseEventQueueStore(createAdminClient({ type: "system", id: `consumer:${consumer}` }));
    results.push(await processConsumer({ consumer, handler, store }));
  }
  return NextResponse.json({ consumers: results });
}

export const GET = handle;
export const POST = handle;
