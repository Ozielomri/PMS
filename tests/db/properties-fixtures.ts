/** Shared fixtures for the Properties DB tests (step 3). */
import { randomUUID } from "node:crypto";

import { pool, type Db, type RequestContext } from "./helpers";

type User = { id: string; email?: string };

export const COMPLETE: Record<string, unknown> = {
  address_line1: "100 Ocean Drive",
  city: "Miami Beach",
  state_region: "FL",
  postal_code: "33139",
  country_code: "US",
  timezone: "America/New_York",
  max_guests: 4,
  bedrooms: 2,
  bathrooms_full: 1,
  base_price_cents: 18000,
  check_in_from: "16:00",
  check_out_by: "11:00",
};

/** Runs as a user (aal2) inside a transaction that commits. */
export async function run<T>(user: User, fn: (db: Db) => Promise<T>, ctx: Partial<RequestContext> = {}): Promise<T> {
  return inTx({ userId: user.id, aal: "aal2", ...ctx }, fn, true);
}

/**
 * Like run(), but Calendar's public.listing_has_future_bookings() is replaced — inside this
 * transaction only — by a version that returns true for `bookedIds`. Always rolls back.
 */
export async function withFutureBookings<T>(bookedIds: string[], user: User, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx({ userId: user.id, aal: "aal2" }, fn, false, async (db) => {
    await db.query(`
      create or replace function public.listing_has_future_bookings(p_listing_id uuid)
      returns boolean language sql stable security definer set search_path = '' as $$
        select p_listing_id::text = any (string_to_array(coalesce(current_setting('pms_test.booked', true), ''), ','))
      $$`);
    await db.query("select set_config('pms_test.booked', $1, true)", [bookedIds.join(",")]);
  });
}

async function inTx<T>(ctx: RequestContext, fn: (db: Db) => Promise<T>, commit: boolean, prepare?: (db: Db) => Promise<void>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (prepare) await prepare(client);
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', '{}', true)", [
      JSON.stringify({ role: "authenticated", sub: ctx.userId, aal: ctx.aal ?? "aal2" }),
    ]);
    await client.query("set local role authenticated");
    const result = await fn(client);
    // Run the deferred constraint triggers now, so failures surface inside fn's transaction.
    await client.query("set constraints all immediate");
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function insertListing(db: Db, accountId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const cols = { account_id: accountId, internal_name: `Unit ${randomUUID().slice(0, 4)}`, ...fields };
  const keys = Object.keys(cols);
  const { rows } = await db.query(
    `insert into public.listings (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(cols),
  );
  return rows[0].id as string;
}

export async function addPhoto(db: Db, accountId: string, listingId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = {
    account_id: accountId,
    listing_id: listingId,
    storage_path: `${accountId}/${listingId}/${randomUUID()}.jpg`,
    content_type: "image/jpeg",
    size_bytes: 1_000_000,
    ...extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await db.query(
    `insert into public.listing_photos (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(cols),
  );
  return rows[0].id as string;
}

/** A complete single unit with one photo, optionally active. */
export async function bookableListing(user: User, accountId: string, opts: { status?: "draft" | "active"; fields?: Record<string, unknown> } = {}) {
  return run(user, async (db) => {
    const id = await insertListing(db, accountId, { ...COMPLETE, ...opts.fields });
    await addPhoto(db, accountId, id);
    if (opts.status === "active") await db.query("update public.listings set status = 'active' where id = $1", [id]);
    return id;
  });
}

/** A complete multi-unit parent with a photo and `units` sub-units. */
export async function multiUnit(user: User, accountId: string, opts: { units?: number; status?: "draft" | "active"; tags?: string[] } = {}) {
  return run(user, async (db) => {
    const parent = await insertListing(db, accountId, { ...COMPLETE, type: "multi_parent", internal_name: "Studios", tags: opts.tags ?? [] });
    await addPhoto(db, accountId, parent);
    const names = Array.from({ length: opts.units ?? 2 }, (_, i) => `Studio ${i + 1}`);
    const { rows } = await db.query("select * from public.add_sub_units($1, $2) as id", [parent, names]);
    if (opts.status === "active") await db.query("update public.listings set status = 'active' where id = $1", [parent]);
    return { parent, subs: rows.map((r) => r.id as string) };
  });
}

export async function listingRow(id: string) {
  const { rows } = await pool.query("select * from public.listings where id = $1", [id]);
  return rows[0];
}
