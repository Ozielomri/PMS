import { NextResponse, type NextRequest } from "next/server";

import { calendarErrorBody, searchParamsObject } from "@/lib/calendar/http";
import { formatIssues, quoteQuerySchema } from "@/lib/calendar/schemas";
import { quoteStay } from "@/lib/calendar/service";
import { createClient } from "@/lib/supabase/server";

/** CAL-05: GET /api/calendar/quote?listing_id&check_in&check_out&guests&pets — itemised quote in cents. */
export async function GET(request: NextRequest) {
  const parsed = quoteQuerySchema.safeParse(searchParamsObject(request.url));
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  const q = parsed.data;
  try {
    const quote = await quoteStay(await createClient(), {
      listingId: q.listing_id,
      checkIn: q.check_in,
      checkOut: q.check_out,
      guests: q.guests,
      pets: q.pets,
    });
    return NextResponse.json(quote);
  } catch (err) {
    const { status, body } = calendarErrorBody(err);
    return NextResponse.json(body, { status });
  }
}
