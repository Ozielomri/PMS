import { NextResponse, type NextRequest } from "next/server";

import { CalendarError } from "@/lib/calendar/service";
import { bearerToken, calendarErrorBody } from "@/lib/calendar/http";
import { formatIssues, pricingToolPayloadSchema } from "@/lib/calendar/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * CAL-15: POST /api/calendar/machine/pricing-tool with `Authorization: Bearer pmspt_…` and
 * `{ "updates": [{ listing_id, from, to, price_cents?, min_nights?, max_nights?,
 * closed_to_arrival?, closed_to_departure?, closed? }] }` (`to` exclusive). All updates apply in
 * one transaction. The token (hashed in the DB, per account) decides which account may be
 * changed; the service-role RPC records every change with source `pricing_tool`.
 */
export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !token.startsWith("pmspt_")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = pricingToolPayloadSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });

  const client = createAdminClient({ type: "api", id: "pricing_tool" });
  const { data, error } = await client.rpc("apply_pricing_tool_updates", { p_token: token, p_updates: parsed.data.updates });
  if (error) {
    const { status, body } = calendarErrorBody(new CalendarError(error.message, error.code));
    return NextResponse.json(status === 401 ? { error: "unauthorized" } : body, { status });
  }
  return NextResponse.json(data);
}
