import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * CAL-01 + hold expiry. Scheduled hourly by Vercel Schedules (vercel.json) with
 * `Authorization: Bearer $CRON_SECRET`. Both steps are idempotent; overlapping runs are safe.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const client = createAdminClient({ type: "system", id: "calendar-maintenance" });
  const extended = await client.rpc("extend_calendar_horizon");
  if (extended.error) return NextResponse.json({ error: `extend_calendar_horizon: ${extended.error.message}` }, { status: 500 });
  const expired = await client.rpc("expire_calendar_holds");
  if (expired.error) return NextResponse.json({ error: `expire_calendar_holds: ${expired.error.message}` }, { status: 500 });
  return NextResponse.json({ nights_added: extended.data, holds_expired: expired.data });
}

export const GET = handle;
export const POST = handle;
