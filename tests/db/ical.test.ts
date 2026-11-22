/**
 * CAL-09 export URLs (token hash, rotate, revoke, availability only, multi-unit rule) and CAL-10
 * import feeds (permissions, sync diff, failure keeps blocks, conflicts with reservations,
 * worker claim), all through the SQL API in migration 20261124001000.
 */
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hold, calendar, createListing, createMultiUnit, day, lastEventSeq } from "./calendar-fixtures";
import { addMember, as, asUser, createAccount, query } from "./helpers";
import { book } from "./reservations-fixtures";

type User = { id: string; email?: string };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => `pmsical_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 11)}`;

async function createExport(user: User, listingId: string, token = newToken()) {
  const id = randomUUID();
  await asUser(user, (db) =>
    db.query("select public.create_ical_export($1, $2, $3, 'v1.iv.tag.ct', $4)", [id, listingId, sha(token), token.slice(-4)]),
  );
  return { id, token };
}

interface ExportFeed {
  listing_key: string;
  timezone: string;
  from: string;
  to: string;
  ranges: { from: string; to: string }[];
}

async function exportAsAnon(token: string): Promise<ExportFeed | null> {
  return as({ role: "anon" }, async (db) => (await db.query("select public.ical_export_calendar($1) as feed", [token])).rows[0].feed);
}

async function addFeed(user: User, listingId: string, url = `https://feeds.example.com/${randomUUID()}.ics`, name = "Airbnb") {
  const id = randomUUID();
  await asUser(user, (db) =>
    db.query("select public.add_ical_feed($1, $2, $3, 'v1.iv.tag.ct', $4, 'feeds.example.com/…')", [id, listingId, name, sha(url)]),
  );
  return id;
}

type Block = { uid: string; check_in: string; check_out: string };

async function sync(feedId: string, events: Block[] | null, meta: Record<string, unknown> = {}, user?: User) {
  const run = async (db: import("./helpers").Db) =>
    (await db.query("select public.apply_ical_feed_sync($1, $2::jsonb, $3::jsonb) as r", [feedId, events === null ? null : JSON.stringify(events), JSON.stringify(meta)])).rows[0]
      .r as Record<string, unknown>;
  if (user) return asUser(user, run);
  return as({ role: "service_role", headers: { "x-pms-actor-type": "channel", "x-pms-actor-id": "ical-sync" } }, run);
}

async function feedRow(feedId: string) {
  const [row] = await query<{
    status: string;
    last_error: string | null;
    events_imported: number;
    last_result: Record<string, unknown> | null;
    conflicts: { uid: string; with: { code: string | null; source_type: string }[] }[];
    consecutive_failures: number;
    next_run_at: Date;
    last_run_at: Date | null;
    etag: string | null;
    active: boolean;
  }>("select * from public.ical_feeds where id = $1", [feedId]);
  return row;
}

async function activeIcalHolds(listingId: string) {
  return query<{ id: string; check_in: string; check_out: string; source_id: string; note: string }>(
    "select id, check_in::text, check_out::text, source_id, note from public.calendar_holds where listing_id = $1 and source_type = 'ical' and status = 'active' order by check_in",
    [listingId],
  );
}

async function setup() {
  const { accountId, admin } = await createAccount();
  const listing = await createListing(accountId);
  return { accountId, admin, listing };
}

describe("iCal export (CAL-09)", () => {
  it("serves busy ranges for a valid token, to anyone holding it, and nothing else", async () => {
    const { admin, listing } = await setup();
    const { token } = await createExport(admin, listing);
    await hold(listing, day(3), day(5), "reservation");
    await hold(listing, day(5), day(6), "manual_block", null);
    await hold(listing, day(10), day(12), "owner_stay");

    const feed = await exportAsAnon(token);
    expect(feed).not.toBeNull();
    expect(feed!.listing_key).toBe(listing);
    expect(feed!.timezone).toBe("America/New_York");
    expect(feed!.ranges).toEqual([
      { from: day(3), to: day(6) },
      { from: day(10), to: day(12) },
    ]);
    // Availability only: dates, no ids, codes, notes or sources.
    expect(Object.keys(feed!.ranges[0]).sort()).toEqual(["from", "to"]);

    expect(await exportAsAnon(newToken())).toBeNull();
    expect(await exportAsAnon("not-a-token")).toBeNull();
    const [{ hash }] = await query<{ hash: string }>("select token_hash as hash from private.ical_export_tokens t join public.ical_exports e on e.id = t.export_id where e.listing_id = $1", [listing]);
    expect(hash).toBe(sha(token));
  });

  it("includes preparation and default-closed nights, not advance notice or the booking window", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await createListing(accountId, { preparation_nights: 1, advance_notice_hours: 72, booking_window_days: 30 });
    const { token } = await createExport(admin, listing);
    await hold(listing, day(10), day(12), "reservation");
    await query("update public.calendar_days set closed = true where listing_id = $1 and night = $2", [listing, day(20)]);
    const feed = await exportAsAnon(token);
    expect(feed!.ranges).toEqual([
      { from: day(9), to: day(13) },
      { from: day(20), to: day(21) },
    ]);
  });

  it("rotates (old URL dies at once) and revokes", async () => {
    const { admin, listing } = await setup();
    const first = await createExport(admin, listing);
    const second = await createExport(admin, listing);
    expect(await exportAsAnon(first.token)).toBeNull();
    expect(await exportAsAnon(second.token)).not.toBeNull();
    const rows = await query<{ id: string; revoked_at: Date | null }>("select id, revoked_at from public.ical_exports where listing_id = $1 order by created_at", [listing]);
    expect(rows.map((r) => r.revoked_at === null)).toEqual([false, true]);

    await asUser(admin, (db) => db.query("select public.revoke_ical_export($1)", [second.id]));
    expect(await exportAsAnon(second.token)).toBeNull();

    const audit = await query<{ action: string }>("select action from public.audit_log where entity_type = 'ical_exports' and entity_id = $1 order by id", [second.id]);
    expect(audit.map((a) => a.action)).toEqual(["insert", "update"]);
    const events = await query<{ type: string }>("select type from public.domain_events where entity_id = $1 order by seq", [second.id]);
    expect(events.map((e) => e.type)).toEqual(["ical_export.created", "ical_export.updated"]);
    const [diff] = await query<{ diff: string }>("select diff::text from public.audit_log where entity_id = $1 and action = 'insert'", [second.id]);
    expect(diff.diff).not.toContain("v1.iv.tag.ct");
  });

  it("records when the URL was last fetched", async () => {
    const { admin, listing } = await setup();
    const { id, token } = await createExport(admin, listing);
    const before = await asUser(admin, async (db) => (await db.query("select public.ical_export_last_access($1) as t", [id])).rows[0].t);
    expect(before).toBeNull();
    await exportAsAnon(token);
    const after = await asUser(admin, async (db) => (await db.query("select public.ical_export_last_access($1) as t", [id])).rows[0].t);
    expect(after).toBeInstanceOf(Date);
  });

  it("marks a multi-unit parent busy only when no unit is free; sub-units export their own holds", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    const parentExport = await createExport(admin, parent);
    const unitExport = await createExport(admin, units[0]);
    await hold(units[0], day(3), day(6), "reservation");
    await hold(units[1], day(4), day(8), "reservation");
    await hold(parent, day(20), day(21), "manual_block", null); // closes the whole group

    expect((await exportAsAnon(parentExport.token))!.ranges).toEqual([
      { from: day(4), to: day(6) },
      { from: day(20), to: day(21) },
    ]);
    expect((await exportAsAnon(unitExport.token))!.ranges).toEqual([
      { from: day(3), to: day(6) },
      { from: day(20), to: day(21) },
    ]);
  });

  it("needs calendar.manage and rejects complexes", async () => {
    const { accountId, admin, listing } = await setup();
    const manager = await addMember(accountId, "manager");
    await expect(createExport(manager, listing)).rejects.toThrow(/forbidden/);
    const other = await createAccount();
    await expect(createExport(other.admin, listing)).rejects.toThrow(/forbidden/);
    await createExport(admin, listing);
    const seen = await asUser(manager, async (db) => (await db.query("select count(*)::int as n from public.ical_exports where listing_id = $1", [listing])).rows[0].n);
    expect(seen).toBe(0);
    const [complex] = await query<{ id: string }>("insert into public.listings (account_id, type, internal_name) values ($1, 'complex', 'Block') returning id", [accountId]);
    await expect(createExport(admin, complex.id)).rejects.toThrow(/complex/);
  });
});

describe("iCal feeds (CAL-10)", () => {
  it("adds feeds with calendar.manage only, once per URL per listing", async () => {
    const { accountId, admin, listing } = await setup();
    const manager = await addMember(accountId, "manager");
    const url = "https://www.airbnb.com/calendar/ical/1.ics?s=secret";
    const feed = await addFeed(admin, listing, url);
    await expect(addFeed(admin, listing, url)).rejects.toThrow(/already imports/);
    await expect(addFeed(manager, listing)).rejects.toThrow(/forbidden/);
    const row = await feedRow(feed);
    expect(row.status).toBe("pending");

    const events = await query<{ type: string; payload: { record: Record<string, unknown> } }>("select type, payload from public.domain_events where entity_id = $1", [feed]);
    expect(events.map((e) => e.type)).toEqual(["ical_feed.created"]);
    expect(events[0].payload.record).not.toHaveProperty("url_ciphertext");
    // Calendar viewers do not see feeds (their URLs are secrets).
    const seen = await asUser(manager, async (db) => (await db.query("select count(*)::int as n from public.ical_feeds where id = $1", [feed])).rows[0].n);
    expect(seen).toBe(0);
  });

  it("sync places, moves and releases ical holds through the calendar", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    const seq = await lastEventSeq();

    let r = await sync(feed, [
      { uid: "a@airbnb", check_in: day(3), check_out: day(5) },
      { uid: "b@airbnb", check_in: day(10), check_out: day(14) },
    ], { etag: '"e1"', skipped: { cancelled: 1 } });
    expect(r).toMatchObject({ status: "ok", events: 2, placed: 2, moved: 0, released: 0 });
    let holds = await activeIcalHolds(listing);
    expect(holds.map((h) => [h.check_in, h.check_out])).toEqual([[day(3), day(5)], [day(10), day(14)]]);
    expect(holds[0].note).toBe("iCal: Airbnb");
    const nights = await calendar([listing], day(3), day(4));
    expect(nights[0].status).toBe("blocked");
    expect(nights[0].reasons[0]).toMatchObject({ reason: "ical_import", source_type: "ical" });

    const row = await feedRow(feed);
    expect(row).toMatchObject({ status: "ok", events_imported: 2, last_error: null, etag: '"e1"', consecutive_failures: 0 });
    expect(row.last_result).toMatchObject({ skipped: { cancelled: 1 } });
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    // Same feed again: nothing changes.
    r = await sync(feed, [
      { uid: "a@airbnb", check_in: day(3), check_out: day(5) },
      { uid: "b@airbnb", check_in: day(10), check_out: day(14) },
    ]);
    expect(r).toMatchObject({ placed: 0, moved: 0, released: 0 });
    expect((await activeIcalHolds(listing)).map((h) => h.id)).toEqual(holds.map((h) => h.id));

    // b changes dates, a vanishes (or was cancelled), c is new.
    r = await sync(feed, [
      { uid: "b@airbnb", check_in: day(11), check_out: day(15) },
      { uid: "c@airbnb", check_in: day(20), check_out: day(21) },
    ]);
    expect(r).toMatchObject({ events: 2, placed: 1, moved: 1, released: 1 });
    holds = await activeIcalHolds(listing);
    expect(holds.map((h) => [h.check_in, h.check_out])).toEqual([[day(11), day(15)], [day(20), day(21)]]);
    const evs = await query<{ uid: string; status: string; check_in: string }>("select uid, status, check_in::text from public.ical_feed_events where feed_id = $1 order by uid", [feed]);
    expect(evs).toEqual([
      { uid: "a@airbnb", status: "removed", check_in: day(3) },
      { uid: "b@airbnb", status: "active", check_in: day(11) },
      { uid: "c@airbnb", status: "active", check_in: day(20) },
    ]);

    const types = await query<{ type: string; entity_id: string }>("select type, entity_id from public.domain_events where seq > $1 order by seq", [seq]);
    expect(types.filter((t) => t.type === "ical_feed.synced").length).toBe(2);
    expect(types.some((t) => t.type === "calendar.updated" && t.entity_id === listing)).toBe(true);
    // The change log attributes the holds to the channel actor.
    const [log] = await query<{ source: string; actor_type: string }>(
      "select source, actor_type from public.calendar_changes where listing_id = $1 and hold_id = $2",
      [listing, holds[1].id],
    );
    expect(log).toEqual({ source: "channel", actor_type: "channel" });
  });

  it("keeps everything on 304 Not Modified and restores a lost block", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }], { etag: '"e1"' });
    const r = await sync(feed, null);
    expect(r).toMatchObject({ unchanged: true, events: 1, status: "ok" });
    expect((await feedRow(feed)).etag).toBe('"e1"');

    const [h] = await activeIcalHolds(listing);
    await as({ role: "service_role" }, (db) => db.query("select public.release_hold($1, 'test')", [h.id]));
    const healed = await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }]);
    expect(healed).toMatchObject({ restored: 1 });
    expect(await activeIcalHolds(listing)).toHaveLength(1);
  });

  it("a failed import keeps existing blocks, records the error and backs off", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }]);
    const seq = await lastEventSeq();
    await as({ role: "service_role" }, (db) => db.query("select public.record_ical_feed_failure($1, 'The feed answered HTTP 500')", [feed]));
    await as({ role: "service_role" }, (db) => db.query("select public.record_ical_feed_failure($1, 'The feed answered HTTP 500')", [feed]));
    const row = await feedRow(feed);
    expect(row).toMatchObject({ status: "error", last_error: "The feed answered HTTP 500", consecutive_failures: 2, events_imported: 1 });
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(await activeIcalHolds(listing)).toHaveLength(1);
    const failed = await query("select 1 from public.domain_events where seq > $1 and type = 'ical_feed.sync_failed'", [seq]);
    expect(failed).toHaveLength(1); // only on a new error

    // The next success clears it.
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }]);
    expect(await feedRow(feed)).toMatchObject({ status: "ok", last_error: null, consecutive_failures: 0 });
  });

  it("rejects malformed event lists without changing anything", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    for (const bad of [
      [{ uid: "a", check_in: day(5), check_out: day(3) }],
      [{ uid: "", check_in: day(3), check_out: day(5) }],
      [{ uid: "a", check_in: "2026-02-30", check_out: day(5) }],
      [{ uid: "a", check_in: day(3), check_out: day(5) }, { uid: "a", check_in: day(6), check_out: day(7) }],
    ]) {
      await expect(sync(feed, bad as Block[])).rejects.toThrow(/invalid_events/);
    }
    expect(await activeIcalHolds(listing)).toHaveLength(0);
  });

  it("records overlaps with reservations as conflicts and never deletes the reservation", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await createListing(accountId);
    const reservationId = await book(admin, listing, day(10), day(13));
    const [{ code }] = await query<{ code: string }>("select code from public.reservations where id = $1", [reservationId]);
    const feed = await addFeed(admin, listing);

    const r = await sync(feed, [
      { uid: "x", check_in: day(12), check_out: day(15) },
      { uid: "y", check_in: day(20), check_out: day(22) },
    ]);
    expect(r).toMatchObject({ status: "conflict", conflicts: 1, placed: 2 });
    const row = await feedRow(feed);
    expect(row.status).toBe("conflict");
    expect(row.last_error).toContain(code);
    expect(row.conflicts).toHaveLength(1);
    expect(row.conflicts[0]).toMatchObject({ uid: "x", with: [{ code, source_type: "reservation" }] });

    const [res] = await query<{ status: string }>("select status from public.reservations where id = $1", [reservationId]);
    expect(res.status).toBe("confirmed");
    // Both reasons show on the overlapping night; the reservation hold is untouched.
    const [night] = await calendar([listing], day(12), day(13));
    expect(night.reasons.map((x) => x.reason).sort()).toEqual(["ical_import", "reservation"]);
    // No new booking can take the iCal nights.
    await expect(book(admin, listing, day(20), day(21))).rejects.toThrow(/ical_import|not available|conflict/i);

    // The external event moves away: the conflict clears.
    await sync(feed, [
      { uid: "x", check_in: day(14), check_out: day(15) },
      { uid: "y", check_in: day(20), check_out: day(22) },
    ]);
    expect(await feedRow(feed)).toMatchObject({ status: "ok", conflicts: [] });
  });

  it("a feed on a multi-unit parent closes the group and conflicts with any unit's booking", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, units } = await createMultiUnit(accountId, 2);
    await hold(units[1], day(5), day(7), "reservation");
    const feed = await addFeed(admin, parent);
    const r = await sync(feed, [{ uid: "p", check_in: day(6), check_out: day(8) }]);
    expect(r).toMatchObject({ status: "conflict" });
    const nights = await calendar([parent, units[0]], day(7), day(8));
    expect(nights.every((n) => n.status === "blocked")).toBe(true);
  });

  it("removing a feed releases its blocks; Sync now as a user is attributed to the user", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }], {}, admin);
    const [log] = await query<{ actor_user_id: string }>("select actor_user_id from public.calendar_changes where listing_id = $1 order by id desc limit 1", [listing]);
    expect(log.actor_user_id).toBe(admin.id);

    const released = await asUser(admin, async (db) => (await db.query("select public.remove_ical_feed($1) as n", [feed])).rows[0].n);
    expect(released).toBe(1);
    expect(await activeIcalHolds(listing)).toHaveLength(0);
    expect(await feedRow(feed)).toMatchObject({ active: false });
    await expect(sync(feed, [])).rejects.toThrow(/ical_feed_removed/);
    await expect(query("delete from public.ical_feeds where id = $1", [feed])).rejects.toThrow(/never deleted/);
    await expect(query("delete from public.ical_feed_events where feed_id = $1", [feed])).rejects.toThrow(/never deleted/);
    const updates = await query<{ type: string }>("select type from public.domain_events where entity_id = $1 and type = 'ical_feed.updated'", [feed]);
    expect(updates).toHaveLength(1);
    // A removed feed can be added again.
    await addFeed(admin, listing);
  });

  it("only audits feed settings, not every run", async () => {
    const { listing, admin } = await setup();
    const feed = await addFeed(admin, listing);
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }]);
    await sync(feed, null);
    const audit = await query<{ action: string }>("select action from public.audit_log where entity_type = 'ical_feeds' and entity_id = $1", [feed]);
    expect(audit.map((a) => a.action)).toEqual(["insert"]);
  });

  it("the worker claims due feeds with a lease, skipping archived listings", async () => {
    const { accountId, admin, listing } = await setup();
    const feed = await addFeed(admin, listing);
    const archived = await createListing(accountId);
    const archivedFeed = await addFeed(admin, archived);
    await query("update public.listings set status = 'archived' where id = $1", [archived]);

    const claim = () =>
      as({ role: "service_role" }, async (db) => (await db.query("select * from public.claim_ical_feeds(200, 60)")).rows as { feed_id: string; timezone: string; url_ciphertext: string }[]);
    const first = await claim();
    const mine = first.find((f) => f.feed_id === feed);
    expect(mine).toMatchObject({ timezone: "America/New_York", url_ciphertext: "v1.iv.tag.ct" });
    expect(first.some((f) => f.feed_id === archivedFeed)).toBe(false);
    expect((await claim()).some((f) => f.feed_id === feed)).toBe(false); // leased

    await sync(feed, []);
    expect((await claim()).some((f) => f.feed_id === feed)).toBe(false); // next run in 15 minutes
    await query("update public.ical_feeds set next_run_at = now() + interval '1 minute' where id = $1", [feed]);
    expect((await claim()).some((f) => f.feed_id === feed)).toBe(true); // due within the 2-minute slack
  });

  it("lets calendar viewers see feed events, not other tenants", async () => {
    const { accountId, admin, listing } = await setup();
    const feed = await addFeed(admin, listing);
    await sync(feed, [{ uid: "a", check_in: day(3), check_out: day(5) }]);
    const manager = await addMember(accountId, "manager");
    const cleaner = await addMember(accountId, "cleaner");
    const other = await createAccount();
    const count = (u: User) => asUser(u, async (db) => (await db.query("select count(*)::int as n from public.ical_feed_events where feed_id = $1", [feed])).rows[0].n);
    expect(await count(manager)).toBe(1);
    expect(await count(cleaner)).toBe(0);
    expect(await count(other.admin)).toBe(0);
    await expect(asUser(other.admin, (db) => db.query("select public.apply_ical_feed_sync($1, '[]'::jsonb)", [feed]))).rejects.toThrow(/forbidden/);
    await expect(asUser(manager, (db) => db.query("select public.record_ical_feed_failure($1, 'x')", [feed]))).rejects.toThrow(/forbidden/);
  });
});
