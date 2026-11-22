/**
 * Typed wrappers around the calendar SQL API (migration 20261122001000). The database enforces
 * every rule and permission; these only shape inputs and outputs. Pass a user client
 * (lib/supabase/server.ts) for user actions, or a service-role client for system work
 * (Reservations, channel sync, jobs) — place/release/move are service-role only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CalendarChanges } from "@/lib/calendar/bulk";
import { quoteFromRpc, type PriceSource, type Quote, type RpcQuote } from "@/lib/calendar/quote";

export type HoldSourceType = "reservation" | "quote" | "owner_stay" | "manual_block" | "ical";
export type BlockReason = "maintenance" | "personal_use" | "other";
export type NightStatus = "available" | "booked" | "blocked";

export type AvailabilityFailure =
  | "listing_not_bookable"
  | "listing_not_active"
  | "invalid_dates"
  | "capacity"
  | "advance_notice"
  | "booking_window"
  | "blocked"
  | "no_units_available"
  | "min_nights"
  | "max_nights"
  | "closed_to_arrival"
  | "closed_to_departure";

export interface NightReason {
  reason: "reservation" | "quote" | "owner_stay" | "manual_block" | "ical_import" | "preparation" | "advance_notice" | "booking_window" | "default_closed" | "no_units_available";
  hold_id?: string;
  source_type?: HoldSourceType;
  source_id?: string | null;
  listing_id?: string;
  note?: string | null;
  block_reason?: BlockReason | null;
}

export interface Availability {
  bookable: boolean;
  reason: AvailabilityFailure | null;
  failures: AvailabilityFailure[];
  message: string;
  nights: number;
  unitId: string | null;
  conflicts: { night?: string; reasons?: NightReason[]; reason?: string }[];
}

export interface CalendarNight {
  listingId: string;
  night: string;
  listingType: "single" | "multi_parent" | "sub_unit";
  parentId: string | null;
  priceCents: number | null;
  priceSource: PriceSource;
  minNights: number;
  maxNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  closed: boolean;
  status: NightStatus;
  reasons: NightReason[];
  /** Multi-unit parents only (allotment). */
  unitsTotal: number | null;
  unitsAvailable: number | null;
}

export interface UpdateResult {
  listingId: string;
  nightsMatched: number;
  nightsChanged: number;
  skipped: number;
  fields: Partial<Record<keyof CalendarChanges, number>>;
}

/** Error raised by the calendar RPCs; `code` is the SQLSTATE (23P01 = calendar conflict). */
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly details?: string,
  ) {
    super(message);
    this.name = "CalendarError";
  }

  get isConflict(): boolean {
    return this.code === "23P01";
  }

  get isForbidden(): boolean {
    return this.code === "42501";
  }
}

async function call<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new CalendarError(error.message, error.code, error.details ?? undefined);
  return data as T;
}

export async function checkAvailability(
  client: SupabaseClient,
  input: { listingId: string; checkIn: string; checkOut: string; guests?: number; ignoreHoldId?: string },
): Promise<Availability> {
  const rows = await call<
    { bookable: boolean; reason: AvailabilityFailure | null; failures: AvailabilityFailure[]; message: string; nights: number; unit_id: string | null; conflicts: Availability["conflicts"] }[]
  >(client, "check_availability", {
    p_listing_id: input.listingId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_guests: input.guests ?? 1,
    p_ignore_hold_id: input.ignoreHoldId ?? null,
  });
  const r = rows[0];
  return { bookable: r.bookable, reason: r.reason, failures: r.failures, message: r.message, nights: r.nights, unitId: r.unit_id, conflicts: r.conflicts };
}

export async function quoteStay(
  client: SupabaseClient,
  input: { listingId: string; checkIn: string; checkOut: string; guests?: number; pets?: number },
): Promise<Quote> {
  const q = await call<RpcQuote>(client, "quote_stay", {
    p_listing_id: input.listingId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_guests: input.guests ?? 1,
    p_pets: input.pets ?? 0,
  });
  return quoteFromRpc(q);
}

interface NightRow {
  listing_id: string;
  night: string;
  listing_type: CalendarNight["listingType"];
  parent_id: string | null;
  price_cents: number | null;
  price_source: PriceSource;
  min_nights: number;
  max_nights: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  closed: boolean;
  status: NightStatus;
  reasons: NightReason[];
  units_total: number | null;
  units_available: number | null;
}

/** Multi-calendar read: listings × [from, to) (to exclusive, at most 400 days). */
export async function getCalendar(client: SupabaseClient, input: { listingIds: string[]; from: string; to: string }): Promise<CalendarNight[]> {
  const rows = await call<NightRow[]>(client, "get_calendar", { p_listing_ids: input.listingIds, p_from: input.from, p_to: input.to });
  return rows.map((r) => ({
    listingId: r.listing_id,
    night: r.night,
    listingType: r.listing_type,
    parentId: r.parent_id,
    priceCents: r.price_cents,
    priceSource: r.price_source,
    minNights: r.min_nights,
    maxNights: r.max_nights,
    closedToArrival: r.closed_to_arrival,
    closedToDeparture: r.closed_to_departure,
    closed: r.closed,
    status: r.status,
    reasons: r.reasons,
    unitsTotal: r.units_total,
    unitsAvailable: r.units_available,
  }));
}

/** CAL-03 (service role): hold nights; throws CalendarError with isConflict on overlap. Returns the hold id. */
export async function placeHold(
  client: SupabaseClient,
  input: {
    listingId: string;
    checkIn: string;
    checkOut: string;
    sourceType: HoldSourceType;
    sourceId?: string | null;
    expiresAt?: Date | null;
    note?: string | null;
    blockReason?: BlockReason | null;
    enforceRules?: boolean;
    guests?: number;
  },
): Promise<string> {
  return call<string>(client, "place_hold", {
    p_listing_id: input.listingId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId ?? null,
    p_expires_at: input.expiresAt?.toISOString() ?? null,
    p_note: input.note ?? null,
    p_block_reason: input.blockReason ?? null,
    p_enforce_rules: input.enforceRules ?? false,
    p_guests: input.guests ?? 1,
  });
}

export async function releaseHold(client: SupabaseClient, holdId: string, reason?: string): Promise<void> {
  await call<null>(client, "release_hold", { p_hold_id: holdId, p_reason: reason ?? null });
}

/** Move dates and/or listing (alteration, relocation, CAL-11 reassignment). Returns the unit now holding the nights. */
export async function moveHold(client: SupabaseClient, input: { holdId: string; checkIn: string; checkOut: string; listingId?: string }): Promise<string> {
  return call<string>(client, "move_hold", {
    p_hold_id: input.holdId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_listing_id: input.listingId ?? null,
  });
}

export async function blockDates(
  client: SupabaseClient,
  input: { listingIds: string[]; from: string; to: string; reason?: BlockReason; note?: string | null; preview?: boolean },
) {
  const rows = await call<{ listing_id: string; hold_id: string | null; nights: number; conflicts: unknown[] }[]>(client, "block_dates", {
    p_listing_ids: input.listingIds,
    p_from: input.from,
    p_to: input.to,
    p_block_reason: input.reason ?? "other",
    p_note: input.note ?? null,
    p_preview: input.preview ?? false,
  });
  return rows.map((r) => ({ listingId: r.listing_id, holdId: r.hold_id, nights: r.nights, conflicts: r.conflicts }));
}

export async function unblockDates(client: SupabaseClient, input: { listingIds: string[]; from: string; to: string; preview?: boolean }) {
  const rows = await call<{ listing_id: string; holds_released: number; holds_trimmed: number; holds_split: number; nights_unblocked: number }[]>(
    client,
    "unblock_dates",
    { p_listing_ids: input.listingIds, p_from: input.from, p_to: input.to, p_preview: input.preview ?? false },
  );
  return rows.map((r) => ({
    listingId: r.listing_id,
    holdsReleased: r.holds_released,
    holdsTrimmed: r.holds_trimmed,
    holdsSplit: r.holds_split,
    nightsUnblocked: r.nights_unblocked,
  }));
}

/** CAL-12 bulk update; `preview: true` returns the same counts without writing. */
export async function updateCalendar(
  client: SupabaseClient,
  input: { listingIds: string[]; from: string; to: string; changes: CalendarChanges; daysOfWeek?: number[]; preview?: boolean },
): Promise<UpdateResult[]> {
  const rows = await call<{ listing_id: string; nights_matched: number; nights_changed: number; skipped: number; fields: UpdateResult["fields"] }[]>(
    client,
    "update_calendar",
    {
      p_listing_ids: input.listingIds,
      p_from: input.from,
      p_to: input.to,
      p_changes: input.changes,
      p_days_of_week: input.daysOfWeek ?? null,
      p_preview: input.preview ?? false,
    },
  );
  return rows.map((r) => ({ listingId: r.listing_id, nightsMatched: r.nights_matched, nightsChanged: r.nights_changed, skipped: r.skipped, fields: r.fields }));
}
