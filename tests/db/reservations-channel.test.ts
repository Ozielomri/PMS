/**
 * RES-02 channel ingest (idempotent create / modify / cancel), channel-only changes, RES-12 guests,
 * RES-14 search, RES-19 events, grid bookings.
 */
import { describe, expect, it } from "vitest";

import { createListing, day } from "./calendar-fixtures";
import { addMember, as, createAccount, query } from "./helpers";
import { book, lines, reservation, sqlAs, totals } from "./reservations-fixtures";

const service = { role: "service_role" as const };

async function ingest(accountId: string, externalId: string, payload: Record<string, unknown>) {
  return as(service, async (db) => {
    const { rows } = await db.query("select public.ingest_channel_reservation($1, 'booking_com', $2, $3::jsonb) as r", [
      accountId,
      externalId,
      JSON.stringify(payload),
    ]);
    return rows[0].r as { reservation_id: string; created: boolean; changed: boolean };
  });
}

async function setup() {
  const { accountId, admin } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const listing = await createListing(accountId, { base_price_cents: 10000 });
  return { accountId, admin, manager, listing };
}

function payload(listing: string, extra: Record<string, unknown> = {}) {
  return {
    action: "create",
    listing_id: listing,
    check_in: day(10),
    check_out: day(13),
    adults: 2,
    guest: { first_name: "Ana", last_name: "Silva", email: "ana@example.test" },
    lines: [{ kind: "accommodation", label: "3 nights", amount_cents: 33000 }],
    commission_cents: 4950,
    ...extra,
  };
}

describe("channel ingest (RES-02)", () => {
  it("creates exactly one reservation when the same webhook arrives many times at once (acceptance)", async () => {
    const { accountId, listing } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ingest(accountId, "BDC-1001", payload(listing))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const created = results.filter((r) => r.status === "fulfilled" && r.value.created);
    expect(created).toHaveLength(1);
    const rows = await query("select id from public.reservations where account_id = $1 and channel_reservation_id = 'BDC-1001'", [accountId]);
    expect(rows).toHaveLength(1);
    const id = rows[0].id as string;
    expect(await totals(id)).toMatchObject({ guestTotal: 33000, commission: 4950 });
    expect((await lines(id)).every((l) => l.source === "channel")).toBe(true);
  });

  it("applies modifications (dates, total) and cancellations from the channel", async () => {
    const { accountId, listing } = await setup();
    const { reservation_id: id } = await ingest(accountId, "BDC-2", payload(listing));
    await ingest(accountId, "BDC-2", payload(listing, { action: "modify", check_out: day(14), lines: [{ kind: "accommodation", label: "4 nights", amount_cents: 44000 }] }));
    expect((await reservation(id)).check_out).toBe(day(14));
    expect((await totals(id)).guestTotal).toBe(44000);
    expect((await lines(id)).at(-1)).toMatchObject({ kind: "adjustment", source: "channel" });

    const again = await ingest(accountId, "BDC-2", payload(listing, { action: "modify", check_out: day(14), lines: [{ kind: "accommodation", label: "4 nights", amount_cents: 44000 }] }));
    expect(again.changed).toBe(false);

    await ingest(accountId, "BDC-2", { action: "cancel" });
    const r = await reservation(id);
    expect([r.status, r.canceled_by, r.refund_percent]).toEqual(["canceled", "channel", 100]);
    const [ev] = await query<{ actor_type: string; actor_id: string }>(
      "select actor_type, actor_id from public.domain_events where entity_id = $1 and type = 'reservation.status_changed' order by seq desc limit 1",
      [id],
    );
    expect(ev).toEqual({ actor_type: "channel", actor_id: "booking_com" });
  });

  it("refuses PMS-side changes to channel bookings and to the ingest function", async () => {
    const { accountId, listing, manager } = await setup();
    const { reservation_id: id } = await ingest(accountId, "BDC-3", payload(listing));
    await expect(sqlAs(manager, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(15)])).rejects.toThrow(/change_on_channel/);
    await expect(sqlAs(manager, "select public.cancel_reservation($1)", [id])).rejects.toThrow(/change_on_channel/);
    await sqlAs(manager, "select public.set_stay_status($1, 'checked_in')", [id]);
    await expect(sqlAs(manager, "select public.ingest_channel_reservation($1, 'booking_com', 'X', '{}'::jsonb)", [accountId])).rejects.toThrow(/permission denied/);
    await expect(book(manager, listing, day(20), day(22), { source: "booking_com" })).rejects.toThrow(/channel_source/);
  });

  it("never double-books: a channel booking on taken nights fails", async () => {
    const { accountId, listing, manager } = await setup();
    await book(manager, listing, day(10), day(12));
    await expect(ingest(accountId, "BDC-4", payload(listing))).rejects.toThrow(/calendar_conflict/);
    expect(await query("select 1 from public.reservations where channel_reservation_id = 'BDC-4'")).toHaveLength(0);
  });
});

describe("guests (RES-12) and search (RES-14)", () => {
  it("merges duplicates into one record, keeping history", async () => {
    const { manager, listing } = await setup();
    const a = await book(manager, listing, day(10), day(12), { guest: { first_name: "Sam", last_name: "Lee", email: "sam@example.test" } });
    const b = await book(manager, listing, day(20), day(22), { guest: { first_name: "Sam", last_name: "Lee", phone: "+1 555 0100" } });
    const [ga, gb] = [(await query("select guest_id from public.reservations where id = $1", [a]))[0].guest_id, (await query("select guest_id from public.reservations where id = $1", [b]))[0].guest_id];
    const [{ n }] = await sqlAs<{ n: number }>(manager, "select public.merge_guests($1, $2) as n", [ga, gb]);
    expect(n).toBe(1);
    const [g] = await query("select email, phone from public.guests where id = $1", [ga]);
    expect(g).toEqual({ email: "sam@example.test", phone: "+1 555 0100" });
    expect((await query("select merged_into_id from public.guests where id = $1", [gb]))[0].merged_into_id).toBe(ga);
    // New bookings for the merged guest land on the kept record.
    const c = await book(manager, listing, day(30), day(32), { guestId: gb as string });
    expect((await query("select guest_id from public.reservations where id = $1", [c]))[0].guest_id).toBe(ga);
  });

  it("finds reservations by code, name, email and phone", async () => {
    const { accountId, manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12), { guest: { first_name: "Priya", last_name: "Raman", email: "priya@example.test", phone: "(555) 010-9999" } });
    const { code } = await reservation(id);
    for (const q of [code, "priya r", "PRIYA@", "0109999"]) {
      const rows = await sqlAs<{ id: string }>(manager, "select id from public.search_reservations($1, $2)", [accountId, q]);
      expect([q, rows.map((r) => r.id)]).toEqual([q, [id]]);
    }
    const hits = await sqlAs<{ kind: string }>(manager, "select kind from public.global_search($1, 'Priya')", [accountId]);
    expect(hits.map((h) => h.kind).sort()).toEqual(["guest", "reservation"]);
  });
});

describe("events (RES-19) and the calendar grid", () => {
  it("emits created, status_changed, dates_changed and updated", async () => {
    const { manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12), { status: "reserved" });
    await sqlAs(manager, "select public.confirm_reservation($1)", [id]);
    await sqlAs(manager, "select public.alter_reservation($1, p_check_out => $2::date)", [id, day(13)]);
    await sqlAs(manager, "select public.update_reservation_details($1, p_eta => '15:30')", [id]);
    const types = (await query<{ type: string }>("select type from public.domain_events where entity_id = $1 and type like 'reservation.%' order by seq", [id])).map((e) => e.type);
    expect(types).toEqual(["reservation.created", "reservation.status_changed", "reservation.dates_changed", "reservation.updated"]);
  });

  it("returns bookings with guest names for the grid", async () => {
    const { accountId, manager, listing } = await setup();
    const id = await book(manager, listing, day(10), day(12), { guest: { first_name: "Mo", last_name: "Diaz" } });
    const rows = await sqlAs<{ reservation_id: string; guest_name: string; code: string }>(
      manager,
      "select * from public.get_calendar_bookings($1, $2::date, $3::date)",
      [[listing], day(0), day(30)],
    );
    expect(rows).toEqual([expect.objectContaining({ reservation_id: id, guest_name: "Mo Diaz" })]);
    void accountId;
  });
});
