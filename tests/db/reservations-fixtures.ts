/** Shared helpers for the reservation DB tests (tests/db/reservations-*.test.ts). */
import { asUser, query, type Db } from "./helpers";

type User = { id: string; email?: string };

export interface BookOptions {
  status?: "inquiry" | "reserved" | "confirmed";
  kind?: "guest" | "owner_stay";
  source?: string;
  adults?: number;
  children?: number;
  pets?: number;
  overrideCents?: number;
  overrideReason?: string;
  guestId?: string;
  guest?: Record<string, string>;
}

/** public.create_reservation as `user`. Returns the reservation id. */
export async function book(user: User, listingId: string, checkIn: string, checkOut: string, opts: BookOptions = {}): Promise<string> {
  return asUser(user, async (db) => {
    const { rows } = await db.query(
      `select public.create_reservation(
         p_listing_id => $1, p_check_in => $2::date, p_check_out => $3::date,
         p_status => $4::public.reservation_status, p_guest_id => $5, p_guest => $6::jsonb,
         p_adults => $7, p_children => $8, p_pets => $9, p_source => $10, p_kind => $11,
         p_price_override_cents => $12, p_override_reason => $13) as id`,
      [
        listingId,
        checkIn,
        checkOut,
        opts.status ?? "confirmed",
        opts.guestId ?? null,
        opts.guestId ? null : JSON.stringify(opts.guest ?? { first_name: "Jane", last_name: "Guest", email: "jane@example.test" }),
        opts.adults ?? 2,
        opts.children ?? 0,
        opts.pets ?? 0,
        opts.source ?? "direct",
        opts.kind ?? "guest",
        opts.overrideCents ?? null,
        opts.overrideReason ?? null,
      ],
    );
    return rows[0].id as string;
  });
}

export interface ReservationRow {
  id: string;
  code: string;
  status: string;
  stay_status: string | null;
  listing_id: string;
  unit_id: string | null;
  hold_id: string | null;
  check_in: string;
  check_out: string;
  approval_deadline: Date | null;
  refund_percent: number | null;
  canceled_by: string | null;
}

export async function reservation(id: string): Promise<ReservationRow> {
  const [row] = await query<ReservationRow>(
    "select *, check_in::text as check_in, check_out::text as check_out from public.reservations where id = $1",
    [id],
  );
  return row;
}

export async function holdStatus(holdId: string | null): Promise<string | null> {
  if (!holdId) return null;
  const [row] = await query<{ status: string }>("select status from public.calendar_holds where id = $1", [holdId]);
  return row?.status ?? null;
}

export async function totals(id: string) {
  const [row] = await query<{ guest_total: string; stay_total: string; commission: string; paid: string }>(
    "select * from private.reservation_totals($1)",
    [id],
  );
  return { guestTotal: Number(row.guest_total), stayTotal: Number(row.stay_total), commission: Number(row.commission), paid: Number(row.paid) };
}

export async function lines(id: string) {
  return query<{ kind: string; label: string; amount_cents: string; source: string; reason: string | null }>(
    "select kind, label, amount_cents, source, reason from public.reservation_lines where reservation_id = $1 order by id",
    [id],
  );
}

/** Runs SQL as `user` (aal2) and returns rows. */
export function sqlAs<T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(user, async (db: Db) => (await db.query(sql, params)).rows as T[]);
}
