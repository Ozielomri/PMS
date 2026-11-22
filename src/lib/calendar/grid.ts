import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getCalendar, type NightStatus } from "@/lib/calendar/service";

/** One cell of the multi-calendar (a listing × night). Plain data, passed to the client grid. */
export interface GridCell {
  price: number | null;
  priceSource: string;
  minNights: number;
  status: NightStatus;
  closed: boolean;
  cta: boolean;
  ctd: boolean;
  /** Manual block or iCal block on this night (hatched). */
  block: "manual" | "ical" | null;
  blockNote: string | null;
  /** Booked by something other than a bar we draw (preparation time, advance notice…). */
  reason: string | null;
  unitsAvailable: number | null;
  unitsTotal: number | null;
}

export interface GridRow {
  id: string;
  name: string;
  type: "single" | "multi_parent" | "sub_unit";
  parentId: string | null;
  status: string;
  cells: Record<string, GridCell>;
}

export interface GridBooking {
  holdId: string;
  /** Row the bar is drawn on (the unit holding the nights). */
  listingId: string;
  checkIn: string;
  checkOut: string;
  sourceType: "reservation" | "owner_stay" | "quote";
  expiresAt: string | null;
  reservationId: string | null;
  /** What the guest booked (a multi-unit parent, or the row itself). */
  bookedListingId: string | null;
  code: string | null;
  status: string | null;
  stayStatus: string | null;
  source: string | null;
  guestName: string | null;
  guests: number | null;
}

interface ListingRow {
  id: string;
  internal_name: string;
  type: GridRow["type"] | "complex";
  parent_id: string | null;
  status: string;
  tags: string[];
}

export async function loadGrid(
  supabase: SupabaseClient,
  accountId: string,
  opts: { from: string; to: string; q?: string; tag?: string; listingIds?: string[] },
): Promise<{ rows: GridRow[]; bookings: GridBooking[]; tags: string[] }> {
  let query = supabase
    .from("listings")
    .select("id, internal_name, type, parent_id, status, tags")
    .eq("account_id", accountId)
    .neq("status", "archived")
    .neq("type", "complex")
    .order("internal_name")
    .limit(500);
  if (opts.listingIds?.length) query = query.in("id", opts.listingIds);
  const { data } = await query.returns<ListingRow[]>();
  const all = data ?? [];
  const tags = [...new Set(all.flatMap((l) => l.tags))].sort();

  // Filters apply to top-level rows; a multi-unit keeps all its units.
  const q = opts.q?.trim().toLowerCase();
  const top = all.filter((l) => l.type !== "sub_unit" && (!q || l.internal_name.toLowerCase().includes(q)) && (!opts.tag || l.tags.includes(opts.tag)));
  const ordered: ListingRow[] = top.flatMap((l) => [l, ...all.filter((s) => s.parent_id === l.id)]);
  if (opts.listingIds?.length) {
    for (const l of all) if (!ordered.includes(l)) ordered.push(l);
  }
  if (!ordered.length) return { rows: [], bookings: [], tags };

  const ids = ordered.map((l) => l.id);
  const [nights, { data: holds }] = await Promise.all([
    getCalendar(supabase, { listingIds: ids, from: opts.from, to: opts.to }),
    supabase.rpc("get_calendar_bookings", { p_listing_ids: ids, p_from: opts.from, p_to: opts.to }),
  ]);

  const byListing = new Map<string, Record<string, GridCell>>();
  for (const n of nights) {
    const manual = n.reasons.find((r) => r.reason === "manual_block");
    const ical = n.reasons.find((r) => r.reason === "ical_import");
    const other = n.reasons.find((r) => !["reservation", "quote", "owner_stay", "manual_block", "ical_import"].includes(r.reason));
    const cells = byListing.get(n.listingId) ?? {};
    cells[n.night] = {
      price: n.priceCents,
      priceSource: n.priceSource,
      minNights: n.minNights,
      status: n.status,
      closed: n.closed,
      cta: n.closedToArrival,
      ctd: n.closedToDeparture,
      block: manual ? "manual" : ical ? "ical" : null,
      blockNote: manual?.note ?? (manual?.block_reason ? manual.block_reason.replace("_", " ") : null),
      reason: other?.reason ?? null,
      unitsAvailable: n.unitsAvailable,
      unitsTotal: n.unitsTotal,
    };
    byListing.set(n.listingId, cells);
  }

  type HoldRow = {
    hold_id: string;
    listing_id: string;
    check_in: string;
    check_out: string;
    source_type: GridBooking["sourceType"];
    expires_at: string | null;
    reservation_id: string | null;
    code: string | null;
    status: string | null;
    stay_status: string | null;
    source: string | null;
    guest_name: string | null;
    guests: number | null;
  };
  const holdRows = (holds ?? []) as HoldRow[];
  const resIds = holdRows.map((h) => h.reservation_id).filter((x): x is string => Boolean(x));
  const { data: booked } = resIds.length
    ? await supabase.from("reservations").select("id, listing_id").in("id", resIds).returns<{ id: string; listing_id: string }[]>()
    : { data: [] as { id: string; listing_id: string }[] };
  const bookedBy = new Map((booked ?? []).map((b) => [b.id, b.listing_id]));

  return {
    tags,
    rows: ordered.map((l) => ({ id: l.id, name: l.internal_name, type: l.type as GridRow["type"], parentId: l.parent_id, status: l.status, cells: byListing.get(l.id) ?? {} })),
    bookings: holdRows.map((h) => ({
      holdId: h.hold_id,
      listingId: h.listing_id,
      checkIn: h.check_in,
      checkOut: h.check_out,
      sourceType: h.source_type,
      expiresAt: h.expires_at,
      reservationId: h.reservation_id,
      bookedListingId: h.reservation_id ? (bookedBy.get(h.reservation_id) ?? null) : null,
      code: h.code,
      status: h.status,
      stayStatus: h.stay_status,
      source: h.source,
      guestName: h.guest_name,
      guests: h.guests,
    })),
  };
}
