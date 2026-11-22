import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/lib/auth/context";
import { buildReservationsCsv } from "@/lib/reservations/export";
import { parseFilters } from "@/lib/reservations/filters";
import { accountToday, guestName, listReservations, type Balance, type ReservationRow } from "@/lib/reservations/list";
import { createClient } from "@/lib/supabase/server";

/** RES-13 / X-09 CSV export of the filtered reservation list, under RLS. Money only with view_money. */
export async function GET(request: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx || ctx.mfa !== "ok" || !ctx.active || !ctx.can("reservations.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const filters = { ...parseFilters(Object.fromEntries(request.nextUrl.searchParams)), page: 1 };
  const withMoney = ctx.can("reservations.view_money");
  const supabase = await createClient();
  const { today } = await accountToday(supabase, ctx.active.accountId);

  const rows: ReservationRow[] = [];
  const balances = new Map<string, Balance>();
  for (let offset = 0; offset < 5000; offset += 500) {
    const page = await listReservations(supabase, ctx.active.accountId, filters, { today, limit: 500, offset, withMoney });
    rows.push(...page.rows);
    page.balances.forEach((v, k) => balances.set(k, v));
    if (page.rows.length < 500) break;
  }

  const csv = buildReservationsCsv(
    rows.map((r) => {
      const b = balances.get(r.id);
      return {
        code: r.code,
        status: r.status,
        stay_status: r.stay_status,
        kind: r.kind,
        source: r.source,
        channel_reservation_id: r.channel_reservation_id,
        listing: r.listing?.internal_name ?? "",
        unit: r.unit && r.unit_id !== r.listing_id ? r.unit.internal_name : null,
        guest: guestName(r.guest, r.kind),
        guest_email: r.guest?.email ?? null,
        guest_phone: r.guest?.phone ?? null,
        check_in: r.check_in,
        check_out: r.check_out,
        nights: r.nights,
        adults: r.adults,
        children: r.children,
        infants: r.infants,
        pets: r.pets,
        created_at: r.created_at,
        total_cents: b?.guest_total_cents,
        paid_cents: b?.paid_cents,
        balance_due_cents: b?.balance_due_cents,
        currency: r.currency,
      };
    }),
    withMoney,
  );
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="reservations-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
