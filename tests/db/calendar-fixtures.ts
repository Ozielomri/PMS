/** Shared fixtures for the calendar DB tests (tests/db/calendar-*.test.ts). */
import { addDays, localToday } from "@/lib/calendar/dates";

import { asSystem, query, type Db } from "./helpers";

export const NY = "America/New_York";

/**
 * Columns that make a listing activatable under the Properties rules (address, capacity, times;
 * a photo is added separately). Calendar defaults: $100/night, 4 guests, New York.
 */
const COMPLETE: Record<string, unknown> = {
  status: "active",
  timezone: NY,
  base_price_cents: 10000,
  max_guests: 4,
  bedrooms: 1,
  bathrooms_full: 1,
  address_line1: "1 Test Street",
  city: "Miami",
  state_region: "FL",
  postal_code: "33139",
  country_code: "US",
  check_in_from: "16:00",
  check_out_by: "11:00",
};

async function insertRow(db: Db, cols: Record<string, unknown>): Promise<string> {
  const keys = Object.keys(cols);
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(cols),
  );
  return rows[0].id;
}

async function addPhotos(db: Db, accountId: string, listingIds: string[]): Promise<void> {
  await db.query(
    `insert into public.listing_photos (account_id, listing_id, storage_path, content_type, size_bytes)
     select $1::uuid, l, $1::text || '/' || l || '/cover.jpg', 'image/jpeg', 1000000 from unnest($2::uuid[]) l`,
    [accountId, listingIds],
  );
}

/**
 * Inserts a complete listing with a photo directly (as the database owner), active unless
 * `status` says otherwise. Activation is checked at commit, so it all runs in one transaction.
 * Every calendar test creates listings through this file only.
 */
export async function createListing(accountId: string, fields: Record<string, unknown> = {}): Promise<string> {
  return asSystem(async (db) => {
    const id = await insertRow(db, {
      account_id: accountId,
      internal_name: `Unit ${Math.random().toString(36).slice(2, 8)}`,
      ...COMPLETE,
      ...fields,
    });
    await addPhotos(db, accountId, [id]);
    return id;
  });
}

/** Many plain active listings at once (background volume for performance tests). */
export async function createListings(accountId: string, count: number, fields: { base_price_cents?: number } = {}): Promise<string[]> {
  return asSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.listings (account_id, internal_name, status, timezone, base_price_cents, max_guests, bedrooms, bathrooms_full,
                                    address_line1, city, state_region, postal_code, country_code, check_in_from, check_out_by)
       select $1, 'Bulk ' || g, 'active', $2, $3, 4, 1, 1, '1 Test Street', 'Miami', 'FL', '33139', 'US', '16:00', '11:00'
       from generate_series(1, $4) g returning id`,
      [accountId, NY, fields.base_price_cents ?? 10000, count],
    );
    const ids = rows.map((r) => r.id);
    await addPhotos(db, accountId, ids);
    return ids;
  });
}

/**
 * A multi-unit parent with `count` sub-units (named A, B, C, … so assignment order is predictable),
 * in one transaction: an active parent needs a sub-unit and an active sub-unit needs its parent.
 */
export async function createMultiUnit(accountId: string, count: number, fields: Record<string, unknown> = {}) {
  return asSystem(async (db) => {
    const parent = await insertRow(db, {
      account_id: accountId,
      internal_name: `Parent ${Math.random().toString(36).slice(2, 8)}`,
      ...COMPLETE,
      type: "multi_parent",
      ...fields,
    });
    await addPhotos(db, accountId, [parent]);
    const units: string[] = [];
    for (let i = 0; i < count; i++) {
      units.push(
        await insertRow(db, {
          account_id: accountId,
          type: "sub_unit",
          parent_id: parent,
          internal_name: `Sub ${String.fromCharCode(65 + i)}`,
          status: fields.status ?? "active",
          timezone: fields.timezone ?? NY,
        }),
      );
    }
    return { parent, units };
  });
}

/** Local date `offset` days from today in the listing timezone. */
export function day(offset: number, tz = NY): string {
  return addDays(localToday(tz), offset);
}

export interface NightRow {
  listing_id: string;
  night: string;
  price_cents: number | null;
  price_source: string;
  min_nights: number;
  max_nights: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  closed: boolean;
  status: "available" | "booked" | "blocked";
  reasons: { reason: string; hold_id?: string; source_type?: string; source_id?: string | null; listing_id?: string; note?: string | null }[];
  units_total: number | null;
  units_available: number | null;
}

const CALENDAR_SQL = `select listing_id, night::text as night, price_cents, price_source, min_nights, max_nights,
  closed_to_arrival, closed_to_departure, closed, status, reasons, units_total, units_available
  from public.get_calendar($1::uuid[], $2::date, $3::date) order by listing_id, night`;

export async function calendar(listingIds: string[], from: string, to: string, db?: Db): Promise<NightRow[]> {
  if (db) return (await db.query<NightRow>(CALENDAR_SQL, [listingIds, from, to])).rows;
  return query<NightRow>(CALENDAR_SQL, [listingIds, from, to]);
}

export async function nightOf(listingId: string, night: string): Promise<NightRow> {
  const [row] = await calendar([listingId], night, addDays(night, 1));
  return row;
}

export interface Availability {
  bookable: boolean;
  reason: string | null;
  failures: string[];
  message: string | null;
  nights: number;
  unit_id: string | null;
  conflicts: unknown[];
}

export async function availability(listingId: string, checkIn: string, checkOut: string, guests = 1, db?: Db): Promise<Availability> {
  const sql = "select * from public.check_availability($1, $2::date, $3::date, $4)";
  if (db) return (await db.query<Availability>(sql, [listingId, checkIn, checkOut, guests])).rows[0];
  return (await query<Availability>(sql, [listingId, checkIn, checkOut, guests]))[0];
}

/** place_hold as the system (service role / Reservations module). Returns the hold id. */
export async function hold(
  listingId: string,
  checkIn: string,
  checkOut: string,
  sourceType = "reservation",
  sourceId: string | null = crypto.randomUUID(),
  expiresAt: string | null = null,
): Promise<string> {
  const [row] = await query<{ id: string }>("select public.place_hold($1, $2::date, $3::date, $4, $5, $6) as id", [
    listingId,
    checkIn,
    checkOut,
    sourceType,
    sourceId,
    expiresAt,
  ]);
  return row.id;
}

export async function holdRow(holdId: string) {
  const [row] = await query<{ listing_id: string; check_in: string; check_out: string; status: string; source_type: string }>(
    "select listing_id, check_in::text, check_out::text, status, source_type from public.calendar_holds where id = $1",
    [holdId],
  );
  return row;
}

export async function calendarEvents(listingId: string, sinceSeq = 0) {
  return query<{ seq: string; txid: string; payload: { listing_id: string; date_from: string; date_to: string; changes: string[] } }>(
    "select seq, txid::text, payload from public.domain_events where type = 'calendar.updated' and entity_id = $1 and seq > $2 order by seq",
    [listingId, sinceSeq],
  );
}

export async function lastEventSeq(): Promise<number> {
  const [row] = await query<{ seq: string | null }>("select max(seq)::text as seq from public.domain_events");
  return Number(row.seq ?? 0);
}

export { asSystem };
