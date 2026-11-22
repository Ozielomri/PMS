/**
 * RES-03 status machine: every allowed transition works (with its calendar effect), every illegal
 * one is rejected, final statuses are immutable, and the TypeScript mirror matches.
 */
import { describe, expect, it } from "vitest";

import { RESERVATION_STATUSES, STAY_STATUSES, canChangeStay, canTransition } from "@/lib/reservations/status";

import { calendar, createListing, day } from "./calendar-fixtures";
import { addMember, asSystem, createAccount, query } from "./helpers";
import { book, holdStatus, reservation, sqlAs } from "./reservations-fixtures";

async function setup() {
  const { accountId, admin } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const listing = await createListing(accountId);
  return { accountId, admin, manager, listing };
}

/** Puts a reservation into `status` through the real RPCs. */
async function reservationIn(status: string, ctx: Awaited<ReturnType<typeof setup>>, offset: number) {
  const { manager, listing } = ctx;
  const ci = day(offset);
  const co = day(offset + 2);
  switch (status) {
    case "inquiry":
    case "reserved":
    case "confirmed":
      return book(manager, listing, ci, co, { status });
    case "declined": {
      const id = await book(manager, listing, ci, co, { status: "reserved" });
      await sqlAs(manager, "select public.decline_reservation($1, 'No')", [id]);
      return id;
    }
    case "closed": {
      const id = await book(manager, listing, ci, co, { status: "inquiry" });
      await sqlAs(manager, "select public.decline_reservation($1)", [id]);
      return id;
    }
    case "expired": {
      const id = await book(manager, listing, ci, co, { status: "reserved" });
      await expireNow(id);
      await sqlAs(manager, "select public.expire_overdue_reservations()");
      return id;
    }
    case "canceled": {
      const id = await book(manager, listing, ci, co, { status: "confirmed" });
      await sqlAs(manager, "select public.cancel_reservation($1, 'host', 'Test')", [id]);
      return id;
    }
  }
  throw new Error(status);
}

/** Moves the approval deadline (and the hold's expiry) into the past. */
async function expireNow(id: string) {
  await asSystem(async (db) => {
    await db.query("update public.calendar_holds set expires_at = now() + interval '1 second' where source_id = $1", [id]);
    await db.query("update public.reservations set approval_deadline = now() + interval '1 second' where id = $1", [id]);
  });
  await new Promise((r) => setTimeout(r, 1100));
}

describe("status machine parity", () => {
  it("matches the TypeScript mirror for every pair", async () => {
    const rows = await query<{ f: string; t: string; ok: boolean }>(
      `select f::text, t::text, private.reservation_transition_allowed(f, t) as ok
       from unnest(enum_range(null::public.reservation_status)) f, unnest(enum_range(null::public.reservation_status)) t`,
    );
    for (const r of rows) expect([r.f, r.t, r.ok]).toEqual([r.f, r.t, canTransition(r.f as never, r.t as never)]);
    expect(rows).toHaveLength(RESERVATION_STATUSES.length ** 2);

    const stay = await query<{ f: string; t: string; ok: boolean }>(
      `select f::text, t::text, private.stay_transition_allowed(f, t) as ok
       from unnest(enum_range(null::public.stay_status)) f, unnest(enum_range(null::public.stay_status)) t`,
    );
    for (const r of stay) expect([r.f, r.t, r.ok]).toEqual([r.f, r.t, canChangeStay(r.f as never, r.t as never)]);
    expect(stay).toHaveLength(STAY_STATUSES.length ** 2);
  });
});

describe("allowed transitions", () => {
  it("inquiry → reserved places a time-limited hold", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12), { status: "inquiry" });
    expect((await reservation(id)).hold_id).toBeNull();
    await sqlAs(ctx.manager, "select public.confirm_reservation($1, 'reserved')", [id]);
    const r = await reservation(id);
    expect(r.status).toBe("reserved");
    expect(r.approval_deadline).toBeInstanceOf(Date);
    const [h] = await query<{ status: string; expires_at: Date }>("select status, expires_at from public.calendar_holds where id = $1", [r.hold_id]);
    expect(h.status).toBe("active");
    expect(Math.round((h.expires_at.getTime() - Date.now()) / 3_600_000)).toBe(24);
  });

  it("inquiry → confirmed places a permanent hold and starts the stay status", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12), { status: "inquiry" });
    await sqlAs(ctx.manager, "select public.confirm_reservation($1, 'confirmed')", [id]);
    const r = await reservation(id);
    expect([r.status, r.stay_status, await holdStatus(r.hold_id)]).toEqual(["confirmed", "upcoming", "active"]);
  });

  it("inquiry → closed", async () => {
    const ctx = await setup();
    const id = await reservationIn("closed", ctx, 10);
    expect((await reservation(id)).status).toBe("closed");
  });

  it("reserved → confirmed (approve) removes the expiry", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12), { status: "reserved" });
    await sqlAs(ctx.manager, "select public.confirm_reservation($1)", [id]);
    const r = await reservation(id);
    const [h] = await query<{ expires_at: Date | null }>("select expires_at from public.calendar_holds where id = $1", [r.hold_id]);
    expect([r.status, r.approval_deadline, h.expires_at]).toEqual(["confirmed", null, null]);
  });

  it("reserved → declined frees the nights", async () => {
    const ctx = await setup();
    const id = await reservationIn("declined", ctx, 10);
    const r = await reservation(id);
    expect([r.status, await holdStatus(r.hold_id)]).toEqual(["declined", "released"]);
    expect((await calendar([ctx.listing], day(10), day(12))).map((n) => n.status)).toEqual(["available", "available"]);
  });

  it("reserved → expired after the deadline, and the nights are free before the sweep runs", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12), { status: "reserved" });
    await expireNow(id);
    expect((await calendar([ctx.listing], day(10), day(12))).map((n) => n.status)).toEqual(["available", "available"]);
    await expect(sqlAs(ctx.manager, "select public.confirm_reservation($1)", [id])).rejects.toThrow(/approval_deadline_passed/);
    const [{ n }] = await sqlAs<{ n: number }>(ctx.manager, "select public.expire_overdue_reservations() as n");
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await reservation(id)).status).toBe("expired");
  });

  it("confirmed → canceled frees the nights", async () => {
    const ctx = await setup();
    const id = await reservationIn("canceled", ctx, 10);
    const r = await reservation(id);
    expect([r.status, r.stay_status, r.canceled_by, await holdStatus(r.hold_id)]).toEqual(["canceled", null, "host", "released"]);
  });

  it("closes inquiries whose check-in has passed", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(-3), day(-1), { status: "inquiry" });
    await sqlAs(ctx.manager, "select public.expire_overdue_reservations()");
    expect((await reservation(id)).status).toBe("closed");
  });
});

describe("illegal transitions", () => {
  it("are all rejected by the database, whatever path writes them", async () => {
    const ctx = await setup();
    let offset = 20;
    for (const from of RESERVATION_STATUSES) {
      const id = await reservationIn(from, ctx, (offset += 3));
      for (const to of RESERVATION_STATUSES) {
        if (to === from || canTransition(from, to)) continue;
        const attempt = query("update public.reservations set status = $2::public.reservation_status where id = $1", [id, to]);
        await expect(attempt, `${from} → ${to}`).rejects.toThrow(/reservation_transition_invalid|reservation_final/);
      }
      expect((await reservation(id)).status).toBe(from);
    }
  });

  it("refuses the wrong RPC for the current status", async () => {
    const ctx = await setup();
    const confirmed = await book(ctx.manager, ctx.listing, day(10), day(12));
    await expect(sqlAs(ctx.manager, "select public.decline_reservation($1)", [confirmed])).rejects.toThrow(/reservation_transition_invalid/);
    await expect(sqlAs(ctx.manager, "select public.confirm_reservation($1, 'reserved')", [confirmed])).rejects.toThrow(/reservation_transition_invalid/);
    const inquiry = await book(ctx.manager, ctx.listing, day(20), day(22), { status: "inquiry" });
    await expect(sqlAs(ctx.manager, "select public.cancel_reservation($1)", [inquiry])).rejects.toThrow(/only confirmed/);
  });

  it("keeps final reservations immutable except tags", async () => {
    const ctx = await setup();
    const id = await reservationIn("canceled", ctx, 10);
    await expect(query("update public.reservations set check_out = check_out + 1 where id = $1", [id])).rejects.toThrow(/reservation_final/);
    await expect(sqlAs(ctx.manager, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(14)])).rejects.toThrow(/reservation_final/);
    await sqlAs(ctx.manager, "select public.update_reservation_details($1, p_tags => array['vip'])", [id]);
    expect((await query<{ tags: string[] }>("select tags from public.reservations where id = $1", [id]))[0].tags).toEqual(["vip"]);
  });

  it("never deletes reservations", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12));
    await expect(query("delete from public.reservations where id = $1", [id])).rejects.toThrow(/never deleted/);
  });
});

describe("stay status (RES-11)", () => {
  it("goes upcoming → checked in → checked out, or no-show, and nothing else", async () => {
    const ctx = await setup();
    const a = await book(ctx.manager, ctx.listing, day(0), day(2));
    await sqlAs(ctx.manager, "select public.set_stay_status($1, 'checked_in')", [a]);
    await expect(sqlAs(ctx.manager, "select public.set_stay_status($1, 'no_show')", [a])).rejects.toThrow(/stay_status_transition_invalid/);
    await sqlAs(ctx.manager, "select public.set_stay_status($1, 'checked_out')", [a]);
    const [r] = await query<{ stay_status: string; checked_in_at: Date; checked_out_at: Date }>(
      "select stay_status, checked_in_at, checked_out_at from public.reservations where id = $1",
      [a],
    );
    expect(r.stay_status).toBe("checked_out");
    expect(r.checked_in_at).toBeInstanceOf(Date);

    const b = await book(ctx.manager, ctx.listing, day(5), day(7));
    await sqlAs(ctx.manager, "select public.set_stay_status($1, 'no_show')", [b]);
    await expect(sqlAs(ctx.manager, "select public.cancel_reservation($1)", [b])).resolves.toBeDefined();
  });

  it("does not exist outside confirmed", async () => {
    const ctx = await setup();
    const id = await book(ctx.manager, ctx.listing, day(10), day(12), { status: "inquiry" });
    await expect(sqlAs(ctx.manager, "select public.set_stay_status($1, 'checked_in')", [id])).rejects.toThrow(/stay_status_transition_invalid/);
  });
});
