/**
 * RES-01 pricing, RES-06 alterations, RES-07 cancellation refunds, RES-08/09/10 money, and access
 * per role.
 */
import { describe, expect, it } from "vitest";

import { cancellationOutcome, refundPercent } from "@/lib/reservations/refunds";

import { calendar, createListing, createMultiUnit, day, hold } from "./calendar-fixtures";
import { addMember, asSystem, createAccount, query } from "./helpers";
import { book, holdStatus, lines, reservation, sqlAs, totals } from "./reservations-fixtures";

async function setup(fields: Record<string, unknown> = {}) {
  const { accountId, admin } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const listing = await createListing(accountId, { base_price_cents: 10000, cleaning_fee_cents: 5000, ...fields });
  return { accountId, admin, manager, listing };
}

describe("pricing at creation (RES-01, RES-08)", () => {
  it("snapshots the calendar quote as lines", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(13));
    expect((await lines(id)).map((l) => [l.kind, Number(l.amount_cents)])).toEqual([
      ["accommodation", 30000],
      ["cleaning_fee", 5000],
    ]);
    expect(await totals(id)).toMatchObject({ guestTotal: 35000, stayTotal: 35000, paid: 0 });
  });

  it("keeps the snapshot when the listing price changes later", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(13));
    await query("update public.listings set base_price_cents = 99900 where id = $1", [listing]);
    expect((await totals(id)).guestTotal).toBe(35000);
  });

  it("records a price override as an adjustment line with its reason", async () => {
    const { manager, listing } = await setup();
    await expect(book(manager, listing, day(10), day(13), { overrideCents: 30000 })).rejects.toThrow(/override_reason_required/);
    const id = await book(manager, listing, day(10), day(13), { overrideCents: 30000, overrideReason: "Repeat guest" });
    expect((await lines(id)).at(-1)).toMatchObject({ kind: "adjustment", amount_cents: "-5000", reason: "Repeat guest" });
    expect((await totals(id)).guestTotal).toBe(30000);
  });

  it("creates owner stays with no price, blocking the calendar", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(13), { kind: "owner_stay" });
    const r = await reservation(id);
    expect(await lines(id)).toEqual([]);
    const nights = await calendar([listing], day(10), day(11));
    expect(nights[0].reasons.map((x) => x.reason)).toEqual(["owner_stay"]);
    expect(r.status).toBe("confirmed");
  });

  it("assigns a free sub-unit on a multi-unit and lets it be moved to another one", async () => {
    const { accountId } = await createAccount();
    const ctx = await setup();
    void accountId;
    const { parent, units } = await createMultiUnit(ctx.accountId, 2, { base_price_cents: 8000 });
    const a = await book(ctx.manager, parent, day(10), day(12));
    const b = await book(ctx.manager, parent, day(10), day(12));
    expect([(await reservation(a)).unit_id, (await reservation(b)).unit_id]).toEqual(units);
    await expect(book(ctx.manager, parent, day(10), day(12))).rejects.toThrow(/calendar_conflict/);
    await sqlAs(ctx.manager, "select public.alter_reservation($1, p_check_in => $2::date, p_check_out => $3::date)", [b, day(20), day(22)]);
    await sqlAs(ctx.manager, "select public.reassign_reservation_unit($1, $2)", [b, units[0]]);
    expect((await reservation(b)).unit_id).toBe(units[0]);
  });
});

describe("alterations (RES-06)", () => {
  it("previews before/after and adds the difference as an adjustment", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(13));
    const [{ p }] = await sqlAs<{ p: { before: { total_cents: number }; after: { total_cents: number }; difference_cents: number; available: boolean } }>(
      manager,
      "select public.alter_reservation($1, p_check_out => $2::date, p_preview => true) as p",
      [id, day(15)],
    );
    expect(p).toMatchObject({ before: { total_cents: 35000 }, after: { total_cents: 55000 }, difference_cents: 20000, available: true });
    expect((await reservation(id)).check_out).toBe(day(13));

    await sqlAs(manager, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(15)]);
    expect((await reservation(id)).check_out).toBe(day(15));
    expect((await lines(id)).at(-1)).toMatchObject({ kind: "adjustment", label: "Alteration", amount_cents: "20000" });
    expect((await calendar([listing], day(14), day(15)))[0].status).toBe("booked");
  });

  it("fails without changing anything when extending into a blocked night (acceptance)", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(13));
    await hold(listing, day(13), day(14), "manual_block", null);
    const before = { r: await reservation(id), lines: await lines(id) };

    await expect(sqlAs(manager, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(15)])).rejects.toThrow(/calendar_conflict/);
    expect(await reservation(id)).toEqual(before.r);
    expect(await lines(id)).toEqual(before.lines);
    const [h] = await query<{ check_out: string }>("select check_out::text from public.calendar_holds where id = $1", [before.r.hold_id]);
    expect(h.check_out).toBe(day(13));
  });

  it("relocates to another listing with the new price", async () => {
    const ctx = await setup();
    const other = await createListing(ctx.accountId, { base_price_cents: 20000 });
    const id = await book(ctx.manager, ctx.listing, day(10), day(12));
    await sqlAs(ctx.manager, "select public.alter_reservation($1, p_listing_id => $2)", [id, other]);
    const r = await reservation(id);
    expect([r.listing_id, r.unit_id]).toEqual([other, other]);
    expect((await totals(id)).guestTotal).toBe(40000);
    expect((await calendar([ctx.listing], day(10), day(11)))[0].status).toBe("available");
  });

  it("checks guest capacity", async () => {
    const { manager, listing } = await setup({ max_guests: 4 });
    const id = await book(manager, listing, day(10), day(12));
    const [{ p }] = await sqlAs<{ p: { available: boolean; availability: { failures: string[] } } }>(
      manager,
      "select public.alter_reservation($1, p_adults => 6, p_preview => true) as p",
      [id],
    );
    expect(p.available).toBe(false);
    expect(p.availability.failures).toContain("capacity");
  });
});

describe("cancellation (RES-07)", () => {
  it.each([
    ["moderate", "guest", 10, 100],
    ["moderate", "guest", 3, 50],
    ["strict", "guest", 10, 50],
    ["strict", "guest", 3, 0],
    ["flexible", "guest", 2, 100],
    ["non_refundable", "guest", 30, 0],
    ["non_refundable", "host", 30, 100],
  ] as const)("%s, canceled by %s %s days ahead → %s %% refundable", async (policy, by, days, pct) => {
    const { manager, listing } = await setup({ cancellation_policy: policy });
    const id = await book(manager, listing, day(days), day(days + 2));
    await sqlAs(manager, "select public.record_payment($1, 25000, 'bank_transfer')", [id]);
    const [{ c }] = await sqlAs<{ c: Record<string, number> }>(manager, "select public.cancel_reservation($1, $2, 'Plans changed') as c", [id, by]);
    const expected = cancellationOutcome(25000, 25000, refundPercent(policy, by, days));
    expect(c).toMatchObject({ refund_percent: pct, kept_cents: expected.keptCents, refund_due_cents: expected.refundDueCents });
    expect((await totals(id)).guestTotal).toBe(expected.keptCents);
    expect((await reservation(id)).refund_percent).toBe(pct);
  });

  it("previews without changing anything; custom refund needs reservations.manage", async () => {
    const ctx = await setup({ cancellation_policy: "custom" });
    const fo = await addMember(ctx.accountId, "front_office");
    const id = await book(ctx.manager, ctx.listing, day(10), day(12));
    await sqlAs(ctx.manager, "select public.cancel_reservation($1, 'guest', null, null, true)", [id]);
    expect((await reservation(id)).status).toBe("confirmed");
    await expect(sqlAs(fo, "select public.cancel_reservation($1, 'guest')", [id])).rejects.toThrow(/forbidden/);
    const [{ c }] = await sqlAs<{ c: { refund_percent: number } }>(ctx.manager, "select public.cancel_reservation($1, 'guest', 'Goodwill', 30) as c", [id]);
    expect(c.refund_percent).toBe(30);
  });
});

describe("folio (RES-09, RES-10)", () => {
  it("adds extras, adjustments and payments; balance due follows", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12));
    await sqlAs(manager, "select public.add_reservation_line($1, 'extra', 'Early check-in', 2500)", [id]);
    await expect(sqlAs(manager, "select public.add_reservation_line($1, 'adjustment', 'Goodwill', -1000)", [id])).rejects.toThrow(/reason/);
    await sqlAs(manager, "select public.add_reservation_line($1, 'adjustment', 'Goodwill', -1000, 'Noisy neighbours')", [id]);
    await sqlAs(manager, "select public.record_payment($1, 10000, 'cash')", [id]);
    const [b] = await sqlAs<{ guest_total_cents: string; paid_cents: string; balance_due_cents: string }>(
      manager,
      "select * from public.reservation_balances where reservation_id = $1",
      [id],
    );
    expect(b).toMatchObject({ guest_total_cents: "26500", paid_cents: "10000", balance_due_cents: "16500" });
  });

  it("never updates or deletes money rows", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12));
    await sqlAs(manager, "select public.record_payment($1, 100, 'cash')", [id]);
    await expect(query("update public.reservation_lines set amount_cents = 1 where reservation_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(query("delete from public.reservation_payments where reservation_id = $1", [id])).rejects.toThrow(/append-only/);
  });

  it("locks financial lines 30 days after check-out, except adjustments", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12));
    // A stay that ended 40 days ago (dates moved directly; the hold is irrelevant here).
    await query("update public.reservations set check_in = $2::date, check_out = $3::date where id = $1", [id, day(-45), day(-40)]);
    await expect(sqlAs(manager, "select public.add_reservation_line($1, 'extra', 'Late fee', 1000)", [id])).rejects.toThrow(/financials_locked/);
    await sqlAs(manager, "select public.add_reservation_line($1, 'adjustment', 'Correction', -500, 'Damage deposit settled')", [id]);
  });
});

describe("access per role", () => {
  it("supervisors see bookings but no money; cleaners see nothing; front office cannot cancel", async () => {
    const ctx = await setup();
    const supervisor = await addMember(ctx.accountId, "supervisor");
    const cleaner = await addMember(ctx.accountId, "cleaner");
    const fo = await addMember(ctx.accountId, "front_office");
    const id = await book(fo, ctx.listing, day(10), day(12));

    const count = async (u: { id: string }, table: string) =>
      Number((await sqlAs<{ n: string }>(u, `select count(*) as n from public.${table} where reservation_id = $1`, [id]))[0].n);
    expect((await sqlAs(supervisor, "select id from public.reservations where id = $1", [id])).length).toBe(1);
    expect(await count(supervisor, "reservation_lines")).toBe(0);
    expect(await count(supervisor, "reservation_balances")).toBe(0);
    expect(await count(fo, "reservation_lines")).toBe(2);
    expect((await sqlAs(cleaner, "select id from public.reservations where id = $1", [id])).length).toBe(0);
    await expect(sqlAs(supervisor, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(13)])).rejects.toThrow(/forbidden/);
    await expect(sqlAs(fo, "select public.cancel_reservation($1)", [id])).rejects.toThrow(/forbidden/);
    await expect(sqlAs(supervisor, "select public.record_payment($1, 100, 'cash')", [id])).rejects.toThrow(/forbidden/);
  });

  it("isolates accounts and respects listing scope", async () => {
    const a = await setup();
    const b = await setup();
    const id = await book(a.manager, a.listing, day(10), day(12));
    expect((await sqlAs(b.manager, "select id from public.reservations where id = $1", [id])).length).toBe(0);
    await expect(sqlAs(b.manager, "select public.cancel_reservation($1)", [id])).rejects.toThrow(/reservation_not_found/);

    const other = await createListing(a.accountId, { tags: ["Austin"] });
    const otherId = await book(a.manager, other, day(10), day(12));
    const fo = await addMember(a.accountId, "front_office");
    await query("update public.listings set tags = '{Miami}' where id = $1", [a.listing]);
    await sqlAs(a.admin, "select public.set_membership_listing_scope($1, 'restricted', $2)", [fo.membershipId, ["Miami"]]);
    const visible = (await sqlAs<{ id: string }>(fo, "select id from public.reservations")).map((r) => r.id);
    expect(visible).toContain(id);
    expect(visible).not.toContain(otherId);
  });

  it("frees the calendar for archive checks only while bookings are in the future", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12));
    expect((await sqlAs<{ b: boolean }>(manager, "select public.listing_has_future_bookings($1) as b", [listing]))[0].b).toBe(true);
    await sqlAs(manager, "select public.cancel_reservation($1)", [id]);
    expect((await sqlAs<{ b: boolean }>(manager, "select public.listing_has_future_bookings($1) as b", [listing]))[0].b).toBe(false);
    expect(await holdStatus((await reservation(id)).hold_id)).toBe("released");
    void asSystem;
  });
});
