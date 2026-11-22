import { NextResponse, type NextRequest } from "next/server";

import { emailConfig, emailProvider } from "@/lib/inbox/config";
import { processOutbox, supabaseOutboxStore } from "@/lib/inbox/outbox";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * INB-10 outbound queue: sends due messages through the email adapter, with retries and backoff.
 * Schedule every minute; overlapping runs are safe (leases). Sending a reply also kicks it.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await processOutbox({
    store: supabaseOutboxStore(createAdminClient({ type: "system", id: "inbox-outbox" })),
    provider: emailProvider(),
    config: emailConfig(),
    limit: 100,
  });
  return NextResponse.json(summary);
}

export const GET = handle;
export const POST = handle;
