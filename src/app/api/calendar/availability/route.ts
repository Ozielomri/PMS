import { NextResponse, type NextRequest } from "next/server";

import { calendarErrorBody, searchParamsObject } from "@/lib/calendar/http";
import { formatIssues, availabilityQuerySchema } from "@/lib/calendar/schemas";
import { checkAvailability } from "@/lib/calendar/service";
import { createClient } from "@/lib/supabase/server";

/**
 * CAL-02: GET /api/calendar/availability?listing_id&check_in&check_out&guests
 * Signed-in user; permissions (calendar.view + listing scope) are checked in the database.
 */
export async function GET(request: NextRequest) {
  const parsed = availabilityQuerySchema.safeParse(searchParamsObject(request.url));
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  const q = parsed.data;
  try {
    const result = await checkAvailability(await createClient(), {
      listingId: q.listing_id,
      checkIn: q.check_in,
      checkOut: q.check_out,
      guests: q.guests,
    });
    return NextResponse.json(result);
  } catch (err) {
    const { status, body } = calendarErrorBody(err);
    return NextResponse.json(body, { status });
  }
}
