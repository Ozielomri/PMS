import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { localToday } from "@/lib/calendar/dates";
import { tabConstraints, type ReservationFilters } from "@/lib/reservations/filters";
import type { ReservationStatus, StayStatus } from "@/lib/reservations/status";

export interface ReservationRow {
  id: string;
  code: string;
  kind: "guest" | "owner_stay";
  status: ReservationStatus;
  stay_status: StayStatus | null;
  source: string;
  channel_reservation_id: string | null;
  listing_id: string;
  unit_id: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  currency: string;
  tags: string[];
  approval_deadline: string | null;
  created_at: string;
  guest: { id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null } | null;
  listing: { internal_name: string; timezone: string } | null;
  unit: { internal_name: string } | null;
}

export interface Balance {
  reservation_id: string;
  guest_total_cents: number;
  paid_cents: number;
  balance_due_cents: number;
  host_payout_cents: number;
}

export const RESERVATION_SELECT =
  "id, code, kind, status, stay_status, source, channel_reservation_id, listing_id, unit_id, check_in, check_out, nights, adults, children, infants, pets, currency, tags, approval_deadline, created_at, " +
  "guest:guests(id, first_name, last_name, email, phone), " +
  "listing:listings!reservations_listing_id_account_id_fkey(internal_name, timezone), " +
  "unit:listings!reservations_unit_id_account_id_fkey(internal_name)";

export function guestName(g: ReservationRow["guest"], kind: string): string {
  if (kind === "owner_stay") return "Owner stay";
  return g ? [g.first_name, g.last_name].filter(Boolean).join(" ") : "—";
}

export async function accountToday(supabase: SupabaseClient, accountId: string): Promise<{ today: string; timeZone: string }> {
  const { data } = await supabase.from("accounts").select("timezone").eq("id", accountId).maybeSingle<{ timezone: string }>();
  const timeZone = data?.timezone ?? "America/New_York";
  return { today: localToday(timeZone), timeZone };
}

/**
 * RES-13: the filtered reservation list. Text search goes through search_reservations (code,
 * guest name, email, phone, channel code); "balance due" through the reservation_balances view.
 */
export async function listReservations(
  supabase: SupabaseClient,
  accountId: string,
  f: ReservationFilters,
  opts: { today: string; limit: number; offset: number; withMoney: boolean },
): Promise<{ rows: ReservationRow[]; total: number; balances: Map<string, Balance> }> {
  let ids: string[] | null = null;
  if (f.q) {
    const { data } = await supabase.rpc("search_reservations", { p_account_id: accountId, p_query: f.q, p_limit: 500 });
    ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  }
  if (f.balanceDue && opts.withMoney) {
    const { data } = await supabase.from("reservation_balances").select("reservation_id").eq("account_id", accountId).gt("balance_due_cents", 0).limit(2000);
    const due = new Set(((data ?? []) as { reservation_id: string }[]).map((r) => r.reservation_id));
    ids = ids ? ids.filter((id) => due.has(id)) : [...due];
  }
  if (ids && ids.length === 0) return { rows: [], total: 0, balances: new Map() };

  const t = tabConstraints(f.tab, opts.today);
  let query = supabase.from("reservations").select(RESERVATION_SELECT, { count: "exact" }).eq("account_id", accountId);
  if (ids) query = query.in("id", ids.slice(0, 500));
  if (f.status) query = query.eq("status", f.status);
  else if (t.statuses) query = query.in("status", t.statuses);
  if (f.stay) query = query.eq("stay_status", f.stay);
  else if (t.stay) query = query.in("stay_status", t.stay);
  if (t.checkInEq) query = query.eq("check_in", t.checkInEq);
  if (t.checkOutEq) query = query.eq("check_out", t.checkOutEq);
  if (t.checkInGte && !f.checkInFrom) query = query.gte("check_in", t.checkInGte);
  if (f.listing) query = query.or(`listing_id.eq.${f.listing},unit_id.eq.${f.listing}`);
  if (f.tag) query = query.contains("tags", [f.tag]);
  if (f.source) query = query.eq("source", f.source);
  if (f.checkInFrom) query = query.gte("check_in", f.checkInFrom);
  if (f.checkInTo) query = query.lte("check_in", f.checkInTo);
  if (f.checkOutFrom) query = query.gte("check_out", f.checkOutFrom);
  if (f.checkOutTo) query = query.lte("check_out", f.checkOutTo);
  if (f.createdFrom) query = query.gte("created_at", `${f.createdFrom}T00:00:00Z`);
  if (f.createdTo) query = query.lt("created_at", `${f.createdTo}T23:59:59.999Z`);
  const newestFirst = f.tab === "all" || f.tab === "pending";
  query = query.order(newestFirst ? "created_at" : "check_in", { ascending: !newestFirst }).order("code").range(opts.offset, opts.offset + opts.limit - 1);

  const { data, count } = await query.returns<ReservationRow[]>();
  const rows = data ?? [];
  const balances = new Map<string, Balance>();
  if (opts.withMoney && rows.length) {
    const { data: b } = await supabase
      .from("reservation_balances")
      .select("reservation_id, guest_total_cents, paid_cents, balance_due_cents, host_payout_cents")
      .in("reservation_id", rows.map((r) => r.id))
      .returns<Balance[]>();
    for (const row of b ?? []) balances.set(row.reservation_id, row);
  }
  return { rows, total: count ?? 0, balances };
}
