/**
 * Prices and rules: base vs override (CAL-04), quotes (CAL-05), bulk updates with preview
 * (CAL-12), change log (CAL-13), batched events (CAL-14), pricing-tool API (CAL-15) and the
 * reaction to listing edits (Properties contract).
 */
import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/calendar/dates";
import { computeQuote, quoteFromRpc, type RpcQuote } from "@/lib/calendar/quote";

import { calendar, calendarEvents, createListing, createMultiUnit, day, hold, lastEventSeq, nightOf } from "./calendar-fixtures";
import { addMember, as, asSystem, asUser, createAccount, query } from "./helpers";

/** Next date on or after `from` with the given day of week (0 = Sunday). */
function nextDow(from: string, dow: number): string {
  let d = from;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== dow) d = addDays(d, 1);
  return d;
}

async function update(listingIds: string[], from: string, to: string, changes: object, opts: { preview?: boolean; dows?: number[] } = {}) {
  return query<{ listing_id: string; nights_matched: number; nights_changed: number; skipped: number; fields: Record<string, number> }>(
    "select * from public.update_calendar($1, $2::date, $3::date, $4::jsonb, $5::int[], $6)",
    [listingIds, from, to, JSON.stringify(changes), opts.dows ?? null, opts.preview ?? false],
  );
}

describe("nightly prices (CAL-04)", () => {
  it("uses the base price, the weekend price on weekend nights, and shows overrides", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { base_price_cents: 15000, weekend_price_cents: 20000 });
    const fri = nextDow(day(10), 5);
    const nights = await calendar([l], addDays(fri, -1), addDays(fri, 3)); // Thu, Fri, Sat, Sun
    expect(nights.map((n) => [n.price_cents, n.price_source])).toEqual([
      [15000, "base"],
      [20000, "weekend"],
      [20000, "weekend"],
      [15000, "base"],
    ]);
    await update([l], addDays(fri, 1), addDays(fri, 2), { price: { op: "set", cents: 30000 } });
    expect(await nightOf(l, addDays(fri, 1))).toMatchObject({ price_cents: 30000, price_source: "override" });
    await update([l], addDays(fri, 1), addDays(fri, 2), { price: { op: "reset" } });
    expect(await nightOf(l, addDays(fri, 1))).toMatchObject({ price_cents: 20000, price_source: "weekend" });
  });

  it("reflects a parent's price edit on all sub-units' future nights at once, with events", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 3, { base_price_cents: 10000 });
    const seq = await lastEventSeq();
    const started = Date.now();
    await asUser(admin, (db) => db.query("update public.listings set base_price_cents = 12500 where id = $1", [parent]));
    const nights = await calendar(units, day(1), day(2));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(nights.map((n) => n.price_cents)).toEqual([12500, 12500, 12500]);
    for (const id of [parent, ...units]) {
      const events = await calendarEvents(id, seq);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ date_from: day(0), changes: ["price"] });
      expect(events[0].payload.date_to >= day(731)).toBe(true);
    }
    const log = await query<{ field: string; old_value: unknown; new_value: unknown; source: string; first: string }>(
      "select field, old_value, new_value, source, lower(nights)::text as first from public.calendar_changes where listing_id = $1",
      [parent],
    );
    expect(log).toEqual([
      { field: "price", old_value: { value: 10000, source: "base" }, new_value: { value: 12500, source: "base" }, source: "user", first: day(0) },
    ]);
  });

  it("leaves overridden nights alone when the base price changes", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { base_price_cents: 10000 });
    await update([l], day(5), day(6), { price: { op: "set", cents: 9000 } });
    await query("update public.listings set base_price_cents = 11000 where id = $1", [l]);
    expect((await calendar([l], day(4), day(7))).map((n) => n.price_cents)).toEqual([11000, 9000, 11000]);
    const ranges = await query<{ r: string }>("select nights::text as r from public.calendar_changes where listing_id = $1 and new_value->>'value' = '11000' order by lower(nights)", [l]);
    expect(ranges[0].r).toBe(`[${day(0)},${day(5)})`);
    expect(ranges[1].r.startsWith(`[${day(6)},`)).toBe(true);
  });
});

describe("quotes (CAL-05)", () => {
  it("returns itemised lines that match the TypeScript quote", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, {
      base_price_cents: 15000,
      weekend_price_cents: 18000,
      cleaning_fee_cents: 8000,
      extra_guest_fee_cents: 2500,
      extra_guest_after: 2,
      pet_fee_cents: 4000,
      weekly_discount_bps: 1000,
      monthly_discount_bps: 2500,
      max_guests: 6,
    });
    await update([l], day(12), day(13), { price: { op: "set", cents: 21000 } });
    for (const [ci, co, guests, pets] of [
      [day(10), day(13), 2, 0],
      [day(10), day(17), 4, 1],
      [day(10), day(40), 3, 0],
    ] as const) {
      const [{ q }] = await query<{ q: RpcQuote }>("select public.quote_stay($1, $2::date, $3::date, $4, $5) as q", [l, ci, co, guests, pets]);
      const listing = (await query("select * from public.listings where id = $1", [l]))[0];
      const expected = computeQuote({
        currency: "USD",
        nightly: q.nightly.map((n) => ({ night: n.night, priceCents: n.price_cents, source: n.source })),
        guests,
        pets,
        cleaningFeeCents: listing.cleaning_fee_cents,
        extraGuestFeeCents: listing.extra_guest_fee_cents,
        extraGuestAfter: listing.extra_guest_after,
        petFeeCents: listing.pet_fee_cents,
        weeklyDiscountBps: listing.weekly_discount_bps,
        monthlyDiscountBps: listing.monthly_discount_bps,
      });
      expect(quoteFromRpc(q)).toEqual(expected);
      expect(q.nights).toBe(q.nightly.length);
    }
    const [{ q }] = await query<{ q: RpcQuote }>("select public.quote_stay($1, $2::date, $3::date, 2, 0) as q", [l, day(10), day(13)]);
    expect(q.nightly.find((n) => n.night === day(12))).toEqual({ night: day(12), price_cents: 21000, source: "override" });
    expect(q.lines.map((x) => x.code)).toEqual(["accommodation", "cleaning_fee"]);
  });

  it("prices a sub-unit from its parent and fails without a price", async () => {
    const { accountId } = await createAccount();
    const { units } = await createMultiUnit(accountId, 1, { base_price_cents: 9900, cleaning_fee_cents: 1000 });
    const [{ q }] = await query<{ q: RpcQuote }>("select public.quote_stay($1, $2::date, $3::date) as q", [units[0], day(3), day(5)]);
    expect(q.total_cents).toBe(9900 * 2 + 1000);
    // Only a draft can lack a price (activation requires one).
    const free = await createListing(accountId, { base_price_cents: null, status: "draft" });
    await expect(query("select public.quote_stay($1, $2::date, $3::date)", [free, day(3), day(5)])).rejects.toThrow(/price_missing/);
  });
});

describe("bulk updates (CAL-12) and change log (CAL-13)", () => {
  it("previews the same counts it applies, across listings and weekdays", async () => {
    const { accountId, admin } = await createAccount();
    const a = await createListing(accountId, { base_price_cents: 10000 });
    const b = await createListing(accountId, { base_price_cents: 20000 });
    const mon = nextDow(day(10), 1);
    const sun = addDays(mon, 14);
    const changes = { price: { op: "percent", percent: 10 }, min_nights: 2 };
    const preview = await update([a, b], mon, sun, changes, { preview: true, dows: [5, 6] });
    expect(preview.map((p) => p.nights_matched)).toEqual([4, 4]);
    expect(preview.map((p) => p.nights_changed)).toEqual([4, 4]);
    expect((await calendar([a], mon, sun)).every((n) => n.price_cents === 10000)).toBe(true);

    const applied = await asUser(admin, (db) =>
      db.query("select * from public.update_calendar($1, $2::date, $3::date, $4::jsonb, $5::int[])", [[a, b], mon, sun, JSON.stringify(changes), [5, 6]]),
    );
    expect(applied.rows.map((r) => [r.nights_matched, r.nights_changed, r.fields])).toEqual(preview.map((p) => [p.nights_matched, p.nights_changed, p.fields]));
    const fri = addDays(mon, 4);
    expect(await nightOf(b, fri)).toMatchObject({ price_cents: 22000, price_source: "override", min_nights: 2 });
    expect(await nightOf(b, addDays(fri, 2))).toMatchObject({ price_cents: 20000, min_nights: 1 });

    // Applying the same absolute change again changes nothing.
    const again = await update([a], mon, sun, { min_nights: 2 }, { dows: [5, 6] });
    expect(again[0].nights_changed).toBe(0);

    const log = await query<{ field: string; nights: string; old_value: unknown; new_value: unknown; source: string; actor_user_id: string }>(
      "select field, nights::text, old_value, new_value, source, actor_user_id from public.calendar_changes where listing_id = $1 order by lower(nights), field",
      [b],
    );
    // Fri + Sat with the same old → new collapse into one range row per field.
    expect(log).toHaveLength(4);
    expect(log[0].nights).toBe(`[${fri},${addDays(fri, 2)})`);
    expect(log[0]).toMatchObject({ field: "min_nights", old_value: { value: 1, source: "listing" }, new_value: { value: 2, source: "override" }, source: "user", actor_user_id: admin.id });
    expect(log[1]).toMatchObject({ field: "price", old_value: { value: 20000, source: "base" }, new_value: { value: 22000, source: "override" } });

    const [perNight] = await asUser(admin, (db) => db.query("select * from public.get_night_changes($1, $2::date)", [b, fri])).then((r) => [r.rows]);
    expect(perNight.map((r: { field: string }) => r.field).sort()).toEqual(["min_nights", "price"]);
  });

  it("supports add, reset, CTA/CTD and open/close, and rejects negative prices", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { base_price_cents: 10000, min_nights: 3 });
    await update([l], day(10), day(12), { price: { op: "add", cents: -2500 }, closed_to_arrival: true, closed_to_departure: true, closed: true });
    expect(await nightOf(l, day(10))).toMatchObject({ price_cents: 7500, closed_to_arrival: true, closed_to_departure: true, closed: true, status: "blocked" });
    await update([l], day(10), day(12), { closed: false, min_nights: null, price: { op: "reset" } });
    expect(await nightOf(l, day(10))).toMatchObject({ price_cents: 10000, closed: false, min_nights: 3, status: "available" });
    await expect(update([l], day(10), day(12), { price: { op: "add", cents: -20000 } })).rejects.toThrow(/price_negative/);
    await expect(update([l], day(10), day(12), { colour: "red" })).rejects.toThrow(/invalid_changes/);
    await expect(update([l], day(10), day(12), { min_nights: 5, max_nights: 2 })).rejects.toThrow(/min_nights/);
  });

  it("edits a sub-unit's rules on its parent", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    const res = await update([units[0], units[1]], day(10), day(11), { price: { op: "set", cents: 5000 } });
    expect(res).toEqual([expect.objectContaining({ listing_id: parent, nights_changed: 1 })]);
    expect((await nightOf(units[1], day(10))).price_cents).toBe(5000);
  });

  it("checks permissions: front office blocks but cannot edit prices; cleaners see nothing", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const fo = await addMember(accountId, "front_office");
    const manager = await addMember(accountId, "manager");
    const cleaner = await addMember(accountId, "cleaner");
    const sql = "select * from public.update_calendar($1, $2::date, $3::date, $4::jsonb)";
    const args = [[l], day(10), day(11), JSON.stringify({ price: { op: "set", cents: 1 } })];
    await expect(asUser(fo, (db) => db.query(sql, args))).rejects.toThrow(/forbidden/);
    await asUser(manager, (db) => db.query(sql, args));
    expect(await asUser(cleaner, async (db) => (await db.query("select count(*)::int as n from public.calendar_days where listing_id = $1", [l])).rows[0].n)).toBe(0);
    expect(await asUser(cleaner, async (db) => (await db.query("select * from public.get_calendar($1, $2::date, $3::date)", [[l], day(1), day(5)])).rowCount)).toBe(0);
    expect(await asUser(fo, async (db) => (await db.query("select count(*)::int as n from public.calendar_changes where listing_id = $1", [l])).rows[0].n)).toBe(1);
    await expect(asUser(manager, (db) => db.query("update public.calendar_days set price_override_cents = 1 where listing_id = $1", [l]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("respects listing scope", async () => {
    const { accountId, admin } = await createAccount();
    const miami = await createListing(accountId, { tags: ["Miami"] });
    const austin = await createListing(accountId, { tags: ["Austin"] });
    const fo = await addMember(accountId, "front_office");
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [fo.membershipId, ["miami"]]));
    const rows = await asUser(fo, async (db) => (await db.query("select distinct listing_id from public.get_calendar($1, $2::date, $3::date)", [[miami, austin], day(1), day(3)])).rows);
    expect(rows).toEqual([{ listing_id: miami }]);
    await expect(
      asUser(fo, (db) => db.query("select * from public.block_dates($1, $2::date, $3::date, 'other', null)", [[austin], day(1), day(3)])),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("calendar.updated events (CAL-14)", () => {
  it("emits one event per listing per transaction with the covered range", async () => {
    const { accountId } = await createAccount();
    const a = await createListing(accountId);
    const b = await createListing(accountId);
    const seq = await lastEventSeq();
    await asSystem(async (db) => {
      await db.query("select * from public.update_calendar($1, $2::date, $3::date, '{\"min_nights\": 2}'::jsonb)", [[a, b], day(10), day(12)]);
      await db.query("select * from public.update_calendar($1, $2::date, $3::date, '{\"price\": {\"op\": \"set\", \"cents\": 5000}}'::jsonb)", [[a], day(20), day(21)]);
      await db.query("select public.place_hold($1, $2::date, $3::date, 'manual_block', null, null)", [a, day(5), day(6)]);
    });
    const ea = await calendarEvents(a, seq);
    expect(ea).toHaveLength(1);
    expect(ea[0].payload).toEqual({ listing_id: a, date_from: day(5), date_to: day(21), changes: ["availability", "min_nights", "price"] });
    const eb = await calendarEvents(b, seq);
    expect(eb.map((e) => e.payload)).toEqual([{ listing_id: b, date_from: day(10), date_to: day(12), changes: ["min_nights"] }]);
    // Previews and no-op updates emit nothing.
    const seq2 = await lastEventSeq();
    await update([a], day(10), day(12), { min_nights: 2 });
    await update([a], day(10), day(12), { min_nights: 4 }, { preview: true });
    expect(await calendarEvents(a, seq2)).toEqual([]);
  });
});

describe("pricing-tool API (CAL-15)", () => {
  it("applies rate and availability updates with a per-account token and records the source", async () => {
    const { accountId, admin } = await createAccount();
    const l = await createListing(accountId, { base_price_cents: 10000 });
    const other = await createAccount();
    const foreign = await createListing(other.accountId);
    const manager = await addMember(accountId, "manager");
    await expect(asUser(manager, (db) => db.query("select * from public.create_pricing_tool_token($1, 'PriceLabs')", [accountId]))).rejects.toThrow(/forbidden/);
    const { token, token_id } = await asUser(admin, async (db) => (await db.query("select * from public.create_pricing_tool_token($1, 'PriceLabs')", [accountId])).rows[0]);
    expect(token).toMatch(/^pmspt_[0-9a-f]{64}$/);
    expect(await asUser(admin, async (db) => Object.keys((await db.query("select * from public.calendar_api_tokens")).rows[0]))).not.toContain("token_hash");

    const call = (tok: string, updates: object[]) =>
      as({ role: "service_role" }, (db) => db.query("select public.apply_pricing_tool_updates($1, $2::jsonb) as r", [tok, JSON.stringify(updates)]));
    const res = await call(token, [
      { listing_id: l, from: day(10), to: day(17), price_cents: 13300, min_nights: 2 },
      { listing_id: l, from: day(20), to: day(22), closed: true },
    ]);
    expect(res.rows[0].r).toMatchObject({ listings: 1, nights_changed: 9 });
    expect(await nightOf(l, day(12))).toMatchObject({ price_cents: 13300, min_nights: 2, price_source: "override" });
    expect((await nightOf(l, day(21))).status).toBe("blocked");
    const sources = await query<{ source: string; actor_type: string; actor_id: string }>(
      "select distinct source, actor_type, actor_id from public.calendar_changes where listing_id = $1",
      [l],
    );
    expect(sources).toEqual([{ source: "pricing_tool", actor_type: "api", actor_id: `pricing_tool:${token_id}` }]);

    await expect(call(token, [{ listing_id: foreign, from: day(10), to: day(11), price_cents: 1 }])).rejects.toThrow(/listing_not_found/);
    await expect(call("pmspt_nope", [{ listing_id: l, from: day(10), to: day(11), price_cents: 1 }])).rejects.toThrow(/invalid_token/);
    await asUser(admin, (db) => db.query("select public.revoke_pricing_tool_token($1)", [token_id]));
    await expect(call(token, [{ listing_id: l, from: day(10), to: day(11), price_cents: 1 }])).rejects.toThrow(/invalid_token/);
    await expect(asUser(admin, (db) => db.query("select public.apply_pricing_tool_updates($1, '[]'::jsonb)", [token]))).rejects.toThrow(/permission denied/);
  });
});

describe("hold expiry job", () => {
  it("expires overdue holds and emits events", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const h = await hold(l, day(10), day(12), "reservation", crypto.randomUUID(), new Date(Date.now() + 60_000).toISOString());
    await query("update public.calendar_holds set expires_at = now() - interval '1 minute' where id = $1", [h]);
    const seq = await lastEventSeq();
    const [{ n }] = await query<{ n: number }>("select public.expire_calendar_holds() as n");
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await query("select status from public.calendar_holds where id = $1", [h]))[0].status).toBe("expired");
    expect((await calendarEvents(l, seq)).map((e) => e.payload.changes)).toEqual([["availability"]]);
  });
});
