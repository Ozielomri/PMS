import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * RES-04 / RES-05 sweep: requests past their approval deadline → Expired, past inquiries → Closed,
 * quotes past their expiry → expired. Idempotent. The reservation list and dashboard also run the
 * account's own sweep on load, so nothing waits on this schedule to look right.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const client = createAdminClient({ type: "system", id: "reservation-expiry" });
  const reservations = await client.rpc("expire_overdue_reservations");
  if (reservations.error) return NextResponse.json({ error: `expire_overdue_reservations: ${reservations.error.message}` }, { status: 500 });
  const quotes = await client.rpc("expire_quotes");
  if (quotes.error) return NextResponse.json({ error: `expire_quotes: ${quotes.error.message}` }, { status: 500 });
  return NextResponse.json({ reservations_expired: reservations.data, quotes_expired: quotes.data });
}

export const GET = handle;
export const POST = handle;
