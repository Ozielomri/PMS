import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { buildIcs, exportEtag, type BusyRange } from "@/lib/ical/generate";
import { tokenFromSegment } from "@/lib/ical/urls";
import { publicEnv } from "@/lib/env";

/**
 * CAL-09: GET /ical/<token>.ics — the listing's availability as iCal, for Airbnb, Vrbo or any
 * calendar app. No session: the unguessable token is the credential (only its hash is stored).
 * Availability only: one "Not available" all-day event per run of busy nights.
 */
interface ExportData {
  listing_key: string;
  ranges: BusyRange[];
}

const BASE_HEADERS = {
  "cache-control": "private, max-age=0, must-revalidate",
  "x-robots-tag": "noindex, nofollow",
};

function notFound() {
  return new Response("Calendar not found\n", { status: 404, headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" } });
}

async function handle(request: NextRequest, ctx: RouteContext<"/ical/[token]">, head: boolean) {
  const { token: segment } = await ctx.params;
  const token = tokenFromSegment(segment);
  if (!token) return notFound();

  const { supabaseUrl, supabasePublishableKey } = publicEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.rpc("ical_export_calendar", { p_token: token });
  if (error) {
    return new Response("Calendar temporarily unavailable\n", {
      status: 503,
      headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "retry-after": "300" },
    });
  }
  if (!data) return notFound();

  const feed = data as ExportData;
  const etag = exportEtag(feed.listing_key, feed.ranges);
  const headers = { ...BASE_HEADERS, etag, "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="calendar.ics"' };
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
    return new Response(null, { status: 304, headers });
  }
  const body = buildIcs({ listingKey: feed.listing_key, ranges: feed.ranges });
  return new Response(head ? null : body, { status: 200, headers });
}

export function GET(request: NextRequest, ctx: RouteContext<"/ical/[token]">) {
  return handle(request, ctx, false);
}

export function HEAD(request: NextRequest, ctx: RouteContext<"/ical/[token]">) {
  return handle(request, ctx, true);
}
