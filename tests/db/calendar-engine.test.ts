/**
 * Calendar engine: horizon (CAL-01), availability rules (CAL-02, CAL-06), atomic holds (CAL-03),
 * manual blocks (CAL-07), preparation time (CAL-08), multi-unit allotment (CAL-11) and the hold
 * status machine.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { addDays, localToday } from "@/lib/calendar/dates";

import {
  availability,
  calendar,
  calendarEvents,
  createListing,
  createMultiUnit,
  day,
  hold,
  holdRow,
  lastEventSeq,
  nightOf,
} from "./calendar-fixtures";
import { addMember, asUser, createAccount, query } from "./helpers";

describe("calendar days (CAL-01)", () => {
  it("creates at least 730 days ahead for new root listings, none for sub-units", async () => {
    const { accountId } = await createAccount();
    const single = await createListing(accountId);
    const wide = await createListing(accountId, { booking_window_days: 1000 });
    const { parent, units } = await createMultiUnit(accountId, 2);
    const rows = await query<{ listing_id: string; first: string; last: string; n: number }>(
      `select listing_id, min(night)::text as first, max(night)::text as last, count(*)::int as n
       from public.calendar_days where listing_id = any($1) group by listing_id`,
      [[single, wide, parent, ...units]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.listing_id, r]));
    expect(by[single].first).toBe(day(0));
    expect(by[single].last >= day(730)).toBe(true);
    expect(by[wide].last >= day(1000)).toBe(true);
    expect(by[parent].last >= day(730)).toBe(true);
    expect(by[units[0]]).toBeUndefined();
  });

  it("extends the horizon daily and skips archived listings", async () => {
    const { accountId } = await createAccount();
    const active = await createListing(accountId);
    const archived = await createListing(accountId);
    await query("update public.listings set status = 'archived' where id = $1", [archived]);
    // Simulate time passing: drop the last 10 nights of both.
    await query("delete from public.calendar_days where listing_id = any($1) and night > $2", [[active, archived], day(720)]);
    const [{ added }] = await query<{ added: number }>("select public.extend_calendar_horizon() as added");
    expect(added).toBeGreaterThanOrEqual(10);
    const [a] = await query<{ last: string }>("select max(night)::text as last from public.calendar_days where listing_id = $1", [active]);
    const [b] = await query<{ last: string }>("select max(night)::text as last from public.calendar_days where listing_id = $1", [archived]);
    expect(a.last >= day(730)).toBe(true);
    expect(b.last).toBe(day(720));
    // Idempotent.
    const [{ added: again }] = await query<{ added: number }>("select public.extend_calendar_horizon() as added");
    expect(again).toBe(0);
  });

  it("generates rows when a draft listing is created and when an archived one returns", async () => {
    const { accountId } = await createAccount();
    const draft = await createListing(accountId, { status: "draft" });
    const [{ n }] = await query<{ n: number }>("select count(*)::int as n from public.calendar_days where listing_id = $1", [draft]);
    expect(n).toBeGreaterThanOrEqual(731);
  });
});

describe("availability check (CAL-02, CAL-06)", () => {
  it("is bookable for free nights and reports nights", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    expect(await availability(l, day(10), day(13), 2)).toMatchObject({ bookable: true, reason: null, failures: [], nights: 3, unit_id: l });
  });

  it("names each failing rule", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { min_nights: 2, max_nights: 10, max_guests: 4, advance_notice_hours: 48, booking_window_days: 90 });
    expect((await availability(l, day(10), day(11))).failures).toContain("min_nights");
    expect((await availability(l, day(10), day(25))).failures).toContain("max_nights");
    expect((await availability(l, day(10), day(12), 5)).failures).toEqual(["capacity"]);
    expect((await availability(l, day(1), day(3))).failures).toEqual(["advance_notice"]);
    expect((await availability(l, day(88), day(91))).failures).toEqual(["booking_window"]);
    expect((await availability(l, day(12), day(10))).reason).toBe("invalid_dates");

    await query(
      "select * from public.update_calendar($1, $2::date, $3::date, '{\"closed_to_arrival\": true}'::jsonb)",
      [[l], day(20), day(21)],
    );
    await query(
      "select * from public.update_calendar($1, $2::date, $3::date, '{\"closed_to_departure\": true}'::jsonb)",
      [[l], day(30), day(31)],
    );
    expect((await availability(l, day(20), day(23))).failures).toEqual(["closed_to_arrival"]);
    expect((await availability(l, day(19), day(23))).bookable).toBe(true); // CTA night inside the stay is fine
    expect((await availability(l, day(27), day(30))).failures).toEqual(["closed_to_departure"]);
    expect((await availability(l, day(27), day(31))).bookable).toBe(true);

    const blocked = await availability(l, day(40), day(43));
    expect(blocked.bookable).toBe(true);
    await hold(l, day(41), day(42), "manual_block", null);
    const after = await availability(l, day(40), day(43));
    expect(after).toMatchObject({ bookable: false, reason: "blocked" });
    expect(after.conflicts).toEqual([expect.objectContaining({ night: day(41), reasons: [expect.objectContaining({ reason: "manual_block" })] })]);
  });

  it("evaluates min nights on the arrival night only", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { min_nights: 1 });
    await query("select * from public.update_calendar($1, $2::date, $3::date, '{\"min_nights\": 3}'::jsonb)", [[l], day(21), day(22)]);
    expect((await availability(l, day(20), day(22))).bookable).toBe(true); // arrival night min 1
    expect((await availability(l, day(21), day(23))).failures).toEqual(["min_nights"]);
    expect((await availability(l, day(21), day(24))).bookable).toBe(true);
  });

  it("evaluates advance notice in the listing timezone", async () => {
    const { accountId } = await createAccount();
    // Same instant, very different local dates: Kiritimati is UTC+14, Pago Pago UTC-11.
    const east = await createListing(accountId, { timezone: "Pacific/Kiritimati" });
    const west = await createListing(accountId, { timezone: "Pacific/Pago_Pago" });
    const eastToday = localToday("Pacific/Kiritimati");
    const westToday = localToday("Pacific/Pago_Pago");
    expect(eastToday).not.toBe(westToday);
    expect((await availability(east, eastToday, addDays(eastToday, 1))).bookable).toBe(true);
    expect((await availability(east, addDays(eastToday, -1), eastToday)).failures).toEqual(["advance_notice"]);
    expect((await availability(west, westToday, addDays(westToday, 1))).bookable).toBe(true);
    const nights = await calendar([east], addDays(eastToday, -1), addDays(eastToday, 1));
    expect(nights.map((n) => n.reasons.map((r) => r.reason))).toEqual([["advance_notice"], []]);
  });

  it("checks multi-unit parents against free sub-units for the whole stay", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    await hold(units[0], day(10), day(12));
    await hold(units[1], day(11), day(13));
    // Each night has one free unit, but no unit is free for 10–13.
    const r = await availability(parent, day(10), day(13));
    expect(r).toMatchObject({ bookable: false, reason: "no_units_available" });
    expect(await availability(parent, day(12), day(14))).toMatchObject({ bookable: true, unit_id: units[0] });
  });

  it("rejects inactive listings and needs calendar.view", async () => {
    const { accountId } = await createAccount();
    const draft = await createListing(accountId, { status: "draft" });
    expect((await availability(draft, day(5), day(6))).reason).toBe("listing_not_active");
    const l = await createListing(accountId);
    const cleaner = await addMember(accountId, "cleaner");
    await expect(asUser(cleaner, (db) => availability(l, day(5), day(6), 1, db))).rejects.toThrow(/forbidden/);
    const fo = await addMember(accountId, "front_office");
    expect((await asUser(fo, (db) => availability(l, day(5), day(6), 1, db))).bookable).toBe(true);
    const other = await createAccount();
    await expect(asUser(other.admin, (db) => availability(l, day(5), day(6), 1, db))).rejects.toThrow(/forbidden/);
  });
});

describe("holds (CAL-03)", () => {
  it("books nights check-in to the night before check-out", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const reservation = randomUUID();
    const h = await hold(l, day(10), day(13), "reservation", reservation);
    const nights = await calendar([l], day(9), day(14));
    expect(nights.map((n) => n.status)).toEqual(["available", "booked", "booked", "booked", "available"]);
    expect(nights[1].reasons).toEqual([expect.objectContaining({ reason: "reservation", hold_id: h, source_id: reservation })]);
    // Back-to-back stays share the turnover day.
    await hold(l, day(13), day(15));
    await hold(l, day(8), day(10));
  });

  it("rejects overlaps with an error naming the conflicting reservation", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const reservation = randomUUID();
    await hold(l, day(10), day(13), "reservation", reservation);
    const err = await hold(l, day(12), day(14)).catch((e: Error & { code?: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("23P01");
    expect((err as Error).message).toMatch(/calendar_conflict/);
    expect((err as Error).message).toContain(reservation);
    // Nothing changed.
    expect((await query("select 1 from public.calendar_holds where listing_id = $1", [l])).length).toBe(1);
  });

  it("guarantees no overlap at the database level even when the functions are bypassed", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    await hold(l, day(10), day(13));
    await expect(
      query(
        `insert into public.calendar_holds (account_id, listing_id, requested_listing_id, check_in, check_out, source_type)
         values ($1, $2, $2, $3, $4, 'reservation')`,
        [accountId, l, day(11), day(12)],
      ),
    ).rejects.toThrow(/calendar_holds_no_overlap/);
  });

  it("blocks reservations on manual blocks, closed nights and archived listings", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    await hold(l, day(10), day(11), "manual_block", null);
    await expect(hold(l, day(9), day(12))).rejects.toThrow(/calendar_conflict.*manual_block/);
    await query("select * from public.update_calendar($1, $2::date, $3::date, '{\"closed\": true}'::jsonb)", [[l], day(20), day(21)]);
    expect((await nightOf(l, day(20))).reasons).toEqual([{ reason: "default_closed" }]);
    await expect(hold(l, day(20), day(22))).rejects.toThrow(/default_closed/);
    await query("update public.listings set status = 'archived' where id = $1", [l]);
    await expect(hold(l, day(30), day(32))).rejects.toThrow(/listing_not_bookable/);
    await expect(hold(l, day(30), day(32), "manual_block", null)).rejects.toThrow(/listing_not_bookable/);
  });

  it("refuses reservations and owner stays on drafts but allows manual blocks there", async () => {
    const { accountId } = await createAccount();
    const draft = await createListing(accountId, { status: "draft" });
    await expect(hold(draft, day(10), day(12))).rejects.toThrow(/listing_not_bookable/);
    await expect(hold(draft, day(10), day(12), "owner_stay")).rejects.toThrow(/listing_not_bookable/);
    await hold(draft, day(10), day(12), "manual_block", null);
    // Draft sub-units are not assigned and do not count towards the allotment.
    const { parent, units } = await createMultiUnit(accountId, 2);
    await query("update public.listings set status = 'draft' where id = $1", [units[0]]);
    expect(await nightOf(parent, day(10))).toMatchObject({ units_total: 1, units_available: 1 });
    const h = await hold(parent, day(10), day(12));
    expect((await holdRow(h)).listing_id).toBe(units[1]);
    await expect(hold(units[0], day(14), day(15))).rejects.toThrow(/listing_not_bookable/);
  });

  it("does not let a manual block cover a reservation", async () => {
    const { accountId, admin } = await createAccount();
    const a = await createListing(accountId);
    const b = await createListing(accountId);
    const reservation = randomUUID();
    await hold(b, day(11), day(12), "reservation", reservation);
    const err = await asUser(admin, (db) =>
      db.query("select * from public.block_dates($1, $2::date, $3::date, 'maintenance', 'Boiler')", [[a, b], day(10), day(14)]),
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/calendar_conflict/);
    expect((err as Error).message).toContain(reservation);
    // All or nothing: listing a was not blocked either.
    expect((await nightOf(a, day(10))).status).toBe("available");
    // Preview names the conflict without writing.
    const preview = await asUser(admin, (db) =>
      db.query("select listing_id, nights, conflicts from public.block_dates($1, $2::date, $3::date, 'maintenance', null, true)", [[a, b], day(10), day(14)]),
    );
    expect(preview.rows.find((r) => r.listing_id === a)).toMatchObject({ nights: 4, conflicts: [] });
    expect(preview.rows.find((r) => r.listing_id === b)?.conflicts).toHaveLength(1);
    expect((await nightOf(a, day(10))).status).toBe("available");
  });

  it("frees nights on release and ignores expired holds", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId);
    const h = await hold(l, day(10), day(12));
    await query("select public.release_hold($1, 'guest cancelled')", [h]);
    expect((await nightOf(l, day(10))).status).toBe("available");
    await query("select public.release_hold($1)", [h]); // idempotent

    const pending = await hold(l, day(20), day(22), "reservation", randomUUID(), new Date(Date.now() + 60_000).toISOString());
    await expect(hold(l, day(20), day(22))).rejects.toThrow(/calendar_conflict/);
    await query("update public.calendar_holds set expires_at = now() - interval '1 second' where id = $1", [pending]);
    expect((await nightOf(l, day(20))).status).toBe("available");
    await hold(l, day(20), day(22));
    expect((await holdRow(pending)).status).toBe("expired");
  });

  it("follows the hold status machine and is never deleted", async () => {
    const { accountId, admin } = await createAccount();
    const l = await createListing(accountId);
    const h = await hold(l, day(10), day(12));
    await query("select public.release_hold($1)", [h]);
    await expect(query("update public.calendar_holds set status = 'active' where id = $1", [h])).rejects.toThrow(/hold_status/);
    await expect(query("update public.calendar_holds set check_in = check_in - 1 where id = $1", [h])).rejects.toThrow(/hold_status/);
    await expect(query("delete from public.calendar_holds where id = $1", [h])).rejects.toThrow(/never deleted/);
    await expect(asUser(admin, (db) => db.query("delete from public.calendar_holds where id = $1", [h]))).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, (db) => db.query("update public.calendar_holds set status = 'released' where id = $1", [h]))).rejects.toThrow(
      /permission denied/,
    );
    const audit = await query<{ action: string }>("select action from public.audit_log where entity_type = 'calendar_holds' and entity_id = $1 order by id", [h]);
    expect(audit.map((a) => a.action)).toEqual(["insert", "update"]);
  });

  it("is a service-role API: users cannot place reservation holds directly", async () => {
    const { accountId, admin } = await createAccount();
    const l = await createListing(accountId);
    await expect(
      asUser(admin, (db) => db.query("select public.place_hold($1, $2::date, $3::date, 'reservation', null, null)", [l, day(5), day(6)])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("manual blocks (CAL-07)", () => {
  it("blocks and unblocks a range on many listings with reason and note, by role", async () => {
    const { accountId } = await createAccount();
    const a = await createListing(accountId);
    const b = await createListing(accountId);
    const fo = await addMember(accountId, "front_office");
    const supervisor = await addMember(accountId, "supervisor");
    await expect(
      asUser(supervisor, (db) => db.query("select * from public.block_dates($1, $2::date, $3::date, 'maintenance', null)", [[a], day(10), day(14)])),
    ).rejects.toThrow(/forbidden/);
    const res = await asUser(fo, (db) =>
      db.query("select listing_id, hold_id, nights from public.block_dates($1, $2::date, $3::date, 'maintenance', 'Paint')", [[a, b], day(10), day(14)]),
    );
    expect(res.rows).toHaveLength(2);
    const night = await nightOf(a, day(12));
    expect(night).toMatchObject({ status: "blocked" });
    expect(night.reasons).toEqual([expect.objectContaining({ reason: "manual_block", note: "Paint", block_reason: "maintenance" })]);

    // Unblock the middle: the block is split in two, the rest stays blocked.
    const un = await asUser(fo, (db) =>
      db.query("select listing_id, nights_unblocked from public.unblock_dates($1, $2::date, $3::date)", [[a], day(11), day(13)]),
    );
    expect(un.rows).toEqual([{ listing_id: a, nights_unblocked: 2 }]);
    expect((await calendar([a], day(10), day(14))).map((n) => n.status)).toEqual(["blocked", "available", "available", "blocked"]);
    // Unblock everything.
    await asUser(fo, (db) => db.query("select * from public.unblock_dates($1, $2::date, $3::date)", [[a, b], day(0), day(30)]));
    expect((await calendar([a, b], day(10), day(14))).every((n) => n.status === "available")).toBe(true);
    const states = await query<{ status: string }>("select status from public.calendar_holds where listing_id = $1 order by created_at", [a]);
    expect(states.map((s) => s.status)).toEqual(["released", "released"]);
  });
});

describe("preparation time (CAL-08)", () => {
  it("blocks N nights before and after each reservation and recalculates on move", async () => {
    const { accountId } = await createAccount();
    const l = await createListing(accountId, { preparation_nights: 1 });
    const h = await hold(l, day(10), day(12));
    const nights = await calendar([l], day(8), day(14));
    expect(nights.map((n) => [n.status, n.reasons.map((r) => r.reason)])).toEqual([
      ["available", []],
      ["blocked", ["preparation"]],
      ["booked", ["reservation"]],
      ["booked", ["reservation"]],
      ["blocked", ["preparation"]],
      ["available", []],
    ]);
    expect(nights[1].reasons[0].hold_id).toBe(h);
    // A back-to-back stay now violates the preparation gap.
    await expect(hold(l, day(12), day(14))).rejects.toThrow(/preparation/);
    expect((await availability(l, day(12), day(14))).failures).toEqual(["blocked"]);
    await hold(l, day(13), day(15));

    // Move the first stay earlier: the preparation nights follow it.
    await query("select public.move_hold($1, $2::date, $3::date)", [h, day(5), day(7)]);
    const moved = await calendar([l], day(4), day(13));
    expect(moved.map((n) => n.reasons.map((r) => r.reason).join(","))).toEqual([
      "preparation",
      "reservation",
      "reservation",
      "preparation",
      "",
      "",
      "",
      "",
      "preparation",
    ]);
  });
});

describe("multi-unit allotment (CAL-11)", () => {
  it("counts free sub-units, auto-assigns bookings on the parent and supports reassignment", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 3, { base_price_cents: 12000 });
    const nightsBefore = await calendar([parent, ...units], day(10), day(11));
    expect(nightsBefore.find((n) => n.listing_id === parent)).toMatchObject({ status: "available", units_total: 3, units_available: 3, price_cents: 12000 });
    // Sub-units take their price and rules from the parent.
    expect(nightsBefore.find((n) => n.listing_id === units[1])).toMatchObject({ price_cents: 12000, units_total: null });

    const h1 = await hold(parent, day(10), day(12));
    const h2 = await hold(parent, day(10), day(12));
    expect((await holdRow(h1)).listing_id).toBe(units[0]);
    expect((await holdRow(h2)).listing_id).toBe(units[1]);
    expect(await nightOf(parent, day(10))).toMatchObject({ status: "available", units_available: 1 });
    const h3 = await hold(parent, day(10), day(12));
    expect(await nightOf(parent, day(10))).toMatchObject({ status: "booked", units_available: 0 });
    await expect(hold(parent, day(11), day(13))).rejects.toThrow(/no_units_available/);

    // Reassign (drag to another row): unit C → free it, move h1 from A to C fails while C is taken.
    await expect(query("select public.move_hold($1, $2::date, $3::date, $4)", [h1, day(10), day(12), units[2]])).rejects.toThrow(/calendar_conflict/);
    await query("select public.release_hold($1)", [h3]);
    const unit = await query<{ u: string }>("select public.move_hold($1, $2::date, $3::date, $4) as u", [h1, day(10), day(12), units[2]]);
    expect(unit[0].u).toBe(units[2]);
    expect((await holdRow(h1)).listing_id).toBe(units[2]);
    expect((await nightOf(units[0], day(10))).status).toBe("available");
  });

  it("closes every sub-unit when the parent is blocked", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    await hold(parent, day(10), day(11), "manual_block", null);
    expect((await nightOf(units[1], day(10))).reasons).toEqual([expect.objectContaining({ reason: "manual_block", listing_id: parent })]);
    expect(await nightOf(parent, day(10))).toMatchObject({ status: "blocked", units_available: 0 });
    await expect(hold(units[1], day(10), day(11))).rejects.toThrow(/calendar_conflict/);
  });

  it("emits calendar.updated for the unit and its parent", async () => {
    const { accountId } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    const seq = await lastEventSeq();
    await hold(parent, day(10), day(12));
    expect((await calendarEvents(units[0], seq)).map((e) => e.payload)).toEqual([
      { listing_id: units[0], date_from: day(10), date_to: day(12), changes: ["availability"] },
    ]);
    expect((await calendarEvents(parent, seq)).map((e) => e.payload.changes)).toEqual([["availability"]]);
  });
});

describe("listing_has_future_bookings (contract)", () => {
  it("is true while a reservation or owner stay holds future nights, for the unit and its parent", async () => {
    const { accountId, admin } = await createAccount();
    const l = await createListing(accountId);
    const { parent, units } = await createMultiUnit(accountId, 2);
    const check = (id: string) =>
      asUser(admin, async (db) => (await db.query("select public.listing_has_future_bookings($1) as b", [id])).rows[0].b as boolean);
    expect(await check(l)).toBe(false);
    await hold(l, day(5), day(6), "manual_block", null);
    expect(await check(l)).toBe(false);
    const h = await hold(l, day(5), day(7), "owner_stay").catch(() => null); // overlaps the block → rejected
    expect(h).toBeNull();
    const r = await hold(l, day(20), day(22));
    expect(await check(l)).toBe(true);
    await query("select public.release_hold($1)", [r]);
    expect(await check(l)).toBe(false);
    await hold(units[1], day(3), day(4), "owner_stay");
    expect(await check(parent)).toBe(true);
    expect(await check(units[0])).toBe(false);
  });

  it("lists a listing's future holds and next arrivals for Properties, within listing scope", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2, { tags: ["Miami"] });
    const other = await createListing(accountId, { tags: ["Austin"] });
    const r1 = randomUUID();
    const h1 = await hold(units[0], day(20), day(22), "reservation", r1);
    const h2 = await hold(units[1], day(8), day(10), "owner_stay");
    const b = await hold(units[1], day(12), day(13), "manual_block", null);
    const past = await hold(other, day(-5), day(-2), "reservation");
    await hold(other, day(30), day(31));

    const future = await asUser(admin, async (db) =>
      (await db.query("select hold_id, listing_id, source_type, source_id, check_in::text from public.listing_future_holds($1)", [parent])).rows,
    );
    expect(future.map((f) => f.hold_id)).toEqual([h2, b, h1]);
    expect(future[2]).toMatchObject({ listing_id: units[0], source_type: "reservation", source_id: r1, check_in: day(20) });
    const otherHolds = await query<{ hold_id: string }>("select hold_id from public.listing_future_holds($1)", [other]);
    expect(otherHolds.map((h) => h.hold_id)).not.toContain(past);

    const fo = await addMember(accountId, "front_office");
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [fo.membershipId, ["miami"]]));
    const arrivals = await asUser(fo, async (db) =>
      (await db.query("select listing_id, check_in::text, hold_id, unit_id from public.next_arrivals($1) order by check_in", [[parent, ...units, other]])).rows,
    );
    expect(arrivals).toEqual([
      { listing_id: parent, check_in: day(8), hold_id: h2, unit_id: units[1] },
      { listing_id: units[1], check_in: day(8), hold_id: h2, unit_id: units[1] },
      { listing_id: units[0], check_in: day(20), hold_id: h1, unit_id: units[0] },
    ]);
    await expect(asUser(fo, (db) => db.query("select * from public.listing_future_holds($1)", [other]))).rejects.toThrow(/forbidden/);
    const cleaner = await addMember(accountId, "cleaner");
    await expect(asUser(cleaner, (db) => db.query("select * from public.listing_future_holds($1)", [parent]))).rejects.toThrow(/forbidden/);
  });
});
