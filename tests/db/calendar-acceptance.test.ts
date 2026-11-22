/**
 * Module 2 acceptance criteria, measured against Postgres:
 *   * 1,000 concurrent booking attempts on the same night → exactly one success (CAL-03)
 *   * multi-calendar read of 50 listings × 31 days < 1.5 s (X-13 scale)
 *   * manual block on 20 listings visible and evented within 3 s (CAL-07, CAL-14)
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { addDays } from "@/lib/calendar/dates";

import { calendar, calendarEvents, createListing, createListings, createMultiUnit, day, lastEventSeq } from "./calendar-fixtures";
import { addMember, asUser, createAccount, query } from "./helpers";

// Separate pool so the attempts really run on many connections at once (the server allows 100;
// leave room for the other test pool and parallel checkouts).
const CONNECTIONS = 40;
const racePool = new pg.Pool({ connectionString: inject("databaseUrl"), max: CONNECTIONS });
afterAll(async () => {
  await racePool.end();
});

async function race(attempts: number, sql: (i: number) => [string, unknown[]]) {
  // Open every connection first, so the attempts are not serialised by connection setup.
  const clients = await Promise.all(Array.from({ length: CONNECTIONS }, () => racePool.connect()));
  clients.forEach((c) => c.release());
  const started = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_, i) => {
      const [text, params] = sql(i);
      return racePool.query(text, params);
    }),
  );
  const ms = performance.now() - started;
  const ok = results.filter((r): r is PromiseFulfilledResult<pg.QueryResult> => r.status === "fulfilled");
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  return { ok, failed, ms };
}

describe("acceptance: never double-book", () => {
  it("1,000 concurrent attempts on the same night → exactly one success", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const night = day(30);
    const { ok, failed, ms } = await race(1000, () => [
      "select public.place_hold($1, $2::date, $3::date, 'reservation', $4, null) as id",
      [l, night, addDays(night, 1), randomUUID()],
    ]);
    console.info(`[CAL-03] 1000 attempts over ${CONNECTIONS} connections: ${ok.length} ok, ${failed.length} rejected in ${Math.round(ms)} ms`);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(999);
    expect(new Set(failed.map((f) => (f.reason as { code?: string }).code))).toEqual(new Set(["23P01"]));
    const [{ n }] = await query<{ n: number }>("select count(*)::int as n from public.calendar_holds where listing_id = $1 and status = 'active'", [l]);
    expect(n).toBe(1);
  });

  it("overlapping (not identical) concurrent stays → no night is held twice", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const { ok } = await race(400, (i) => {
      const start = 10 + (i % 20);
      return ["select public.place_hold($1, $2::date, $3::date, 'reservation', $4, null)", [l, day(start), day(start + 1 + (i % 3)), randomUUID()]];
    });
    expect(ok.length).toBeGreaterThan(0);
    const [{ overlaps }] = await query<{ overlaps: number }>(
      `select count(*)::int as overlaps from public.calendar_holds a join public.calendar_holds b
         on a.listing_id = b.listing_id and a.id < b.id and a.nights && b.nights
       where a.listing_id = $1 and a.status = 'active' and b.status = 'active'`,
      [l],
    );
    expect(overlaps).toBe(0);
  });

  it("300 concurrent attempts on a 3-unit multi-unit → exactly 3 successes on 3 different units", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 3);
    const { ok } = await race(300, () => [
      "select public.place_hold($1, $2::date, $3::date, 'reservation', $4, null) as id",
      [parent, day(30), day(32), randomUUID()],
    ]);
    expect(ok).toHaveLength(3);
    const rows = await query<{ listing_id: string }>("select listing_id from public.calendar_holds where requested_listing_id = $1 and status = 'active'", [parent]);
    expect(rows.map((r) => r.listing_id).sort()).toEqual([...units].sort());
  });
});

describe("acceptance: performance", () => {
  it("reads the multi-calendar for 50 listings × 31 days in under 1.5 s", async () => {
    const { accountId } = await createAccount();
    const manager = await addMember(accountId, "manager");
    // Background volume: more listings in another account (≈ 220k calendar days).
    const other = await createAccount();
    await createListings(other.accountId, 300);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await createListing(accountId, { preparation_nights: i % 2, weekend_price_cents: 15000 }));
    for (let i = 0; i < 2; i++) {
      const mu = await createMultiUnit(accountId, 4);
      ids.push(mu.parent, ...mu.units.slice(0, 4));
    }
    // Some reservations, blocks and overrides on every listing.
    for (const [i, id] of ids.entries()) {
      const isParent = (await query("select type from public.listings where id = $1", [id]))[0].type === "multi_parent";
      if (!isParent) {
        await query("select public.place_hold($1, $2::date, $3::date, 'reservation', $4, null)", [id, day(3 + (i % 5)), day(6 + (i % 5)), randomUUID()]);
        await query("select public.place_hold($1, $2::date, $3::date, 'manual_block', null, null)", [id, day(15), day(17)]).catch(() => undefined);
      }
    }
    await query("select * from public.update_calendar($1, $2::date, $3::date, '{\"price\": {\"op\": \"percent\", \"percent\": 5}, \"min_nights\": 2}'::jsonb)", [
      ids,
      day(0),
      day(31),
    ]);
    expect(ids).toHaveLength(50);

    const timings: number[] = [];
    let rows = 0;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      rows = await asUser(manager, async (db) => (await calendar(ids, day(0), day(31), db)).length);
      timings.push(performance.now() - started);
    }
    const [{ total }] = await query<{ total: number }>("select count(*)::int as total from public.calendar_days");
    console.info(`[X-13] get_calendar 50 × 31 (${rows} rows; ${total} calendar days in the table): ${timings.map((t) => Math.round(t)).join(" / ")} ms`);
    expect(rows).toBe(50 * 31);
    expect(Math.min(...timings)).toBeLessThan(1500);
    expect(Math.max(...timings)).toBeLessThan(1500);
  });

  it("blocks 20 listings, shows it on the grid and emits 20 events within 3 s", async () => {
    const { accountId } = await createAccount();
    const fo = await addMember(accountId, "front_office");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await createListing(accountId));
    const seq = await lastEventSeq();
    const started = performance.now();
    await asUser(fo, (db) => db.query("select * from public.block_dates($1, $2::date, $3::date, 'maintenance', 'Pool repair')", [ids, day(14), day(18)]));
    const grid = await asUser(fo, (db) => calendar(ids, day(14), day(18), db));
    const events = await query<{ entity_id: string }>(
      "select entity_id from public.domain_events where type = 'calendar.updated' and seq > $1 and entity_id = any($2)",
      [seq, ids],
    );
    const ms = performance.now() - started;
    console.info(`[CAL-07] block 20 listings + grid read + ${events.length} events: ${Math.round(ms)} ms`);
    expect(grid.every((n) => n.status === "blocked")).toBe(true);
    expect(new Set(events.map((e) => e.entity_id)).size).toBe(20);
    expect(events).toHaveLength(20);
    expect((await calendarEvents(ids[0], seq))[0].payload).toEqual({ listing_id: ids[0], date_from: day(14), date_to: day(18), changes: ["availability"] });
    expect(ms).toBeLessThan(3000);
  });
});
