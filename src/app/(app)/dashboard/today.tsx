import Link from "next/link";

import { Card } from "@/components/ui";
import type { AuthContext } from "@/lib/auth/context";
import { accountToday, guestName, listReservations, type ReservationRow } from "@/lib/reservations/list";
import { parseFilters } from "@/lib/reservations/filters";
import { createClient } from "@/lib/supabase/server";

/** Today view: arrivals, departures, in-house and requests waiting for approval. */
export async function Today({ ctx }: { ctx: AuthContext & { active: { accountId: string } } }) {
  const supabase = await createClient();
  await supabase.rpc("expire_overdue_reservations");
  const { today } = await accountToday(supabase, ctx.active.accountId);
  const opts = { today, limit: 8, offset: 0, withMoney: false };
  const load = (tab: string) => listReservations(supabase, ctx.active.accountId, parseFilters({ tab }), opts);
  const [arriving, departing, inHouse, pending] = await Promise.all([load("arriving"), load("departing"), load("in_house"), load("pending")]);
  const sections: [string, string, { rows: ReservationRow[]; total: number }][] = [
    ["Arriving today", "arriving", arriving],
    ["Departing today", "departing", departing],
    ["In house", "in_house", inHouse],
    ["Pending approval", "pending", pending],
  ];
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {sections.map(([title, tab, data]) => (
        <Card key={tab}>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-slate-500">{title}</h2>
            <Link href={`/reservations?tab=${tab}`} className="text-2xl font-semibold tabular-nums hover:underline">
              {data.total}
            </Link>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {data.rows.map((r) => (
              <li key={r.id} className="truncate">
                <Link href={`/reservations/${r.id}`} className="hover:underline">
                  {guestName(r.guest, r.kind)}
                </Link>{" "}
                <span className="text-slate-500">· {r.unit && r.unit_id !== r.listing_id ? r.unit.internal_name : r.listing?.internal_name}</span>
              </li>
            ))}
            {data.total === 0 ? <li className="text-slate-400">None</li> : null}
          </ul>
        </Card>
      ))}
    </div>
  );
}
