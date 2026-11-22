/**
 * Step 3 business rules on listings, enforced in the database: activation (PRP business rule),
 * archive (PRP-01), timezone confirmation, cleaning status (PRP-16), tags (PRP-11), events.
 */
import { describe, expect, it } from "vitest";

import { addMember, createAccount, query } from "./helpers";
import { COMPLETE, addPhoto, bookableListing, insertListing, listingRow, run, withFutureBookings } from "./properties-fixtures";

describe("activation requirements", () => {
  it("cannot activate without address, capacity, price, times and a photo", async () => {
    const { accountId, admin } = await createAccount();
    const id = await run(admin, (db) => insertListing(db, accountId));

    await expect(run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [id]))).rejects.toThrow(
      /listing_not_activatable: address, capacity, base_price, check_in_out_times, photo/,
    );
    const problems = await run(admin, async (db) => (await db.query("select public.listing_activation_problems($1) as p", [id])).rows[0].p);
    expect(problems).toEqual(["address", "capacity", "base_price", "check_in_out_times", "photo"]);

    // Fill everything but the photo: still blocked.
    const keys = Object.keys(COMPLETE);
    await run(admin, (db) =>
      db.query(`update public.listings set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...Object.values(COMPLETE)]),
    );
    await expect(run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [id]))).rejects.toThrow(
      /listing_not_activatable: photo$/,
    );

    const photo = await run(admin, (db) => addPhoto(db, accountId, id));
    await run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [id]));
    expect((await listingRow(id)).status).toBe("active");

    // An active listing must stay complete.
    await expect(run(admin, (db) => db.query("delete from public.listing_photos where id = $1", [photo]))).rejects.toThrow(/listing_not_activatable: photo/);
    await expect(run(admin, (db) => db.query("update public.listings set base_price_cents = null where id = $1", [id]))).rejects.toThrow(
      /listing_not_activatable: base_price/,
    );
    await expect(run(admin, (db) => db.query("update public.listings set address_line1 = ' ' where id = $1", [id]))).rejects.toThrow(
      /listing_not_activatable: address/,
    );
  });

  it("checks at commit, so a wizard can create, add a photo and activate in one transaction", async () => {
    const { accountId, admin } = await createAccount();
    const id = await run(admin, async (db) => {
      const listingId = await insertListing(db, accountId, { ...COMPLETE, status: "active" });
      await addPhoto(db, accountId, listingId);
      return listingId;
    });
    expect((await listingRow(id)).status).toBe("active");
    await expect(run(admin, (db) => insertListing(db, accountId, { ...COMPLETE, status: "active" }))).rejects.toThrow(/listing_not_activatable: photo/);
  });

  it("hides the checklist of listings outside the caller's account", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const id = await run(a.admin, (db) => insertListing(db, a.accountId));
    await expect(run(b.admin, (db) => db.query("select public.listing_activation_problems($1)", [id]))).rejects.toThrow(/not_found/);
  });
});

describe("archiving (PRP-01)", () => {
  it("needs properties.manage, keeps the row and records archived_at", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const id = await bookableListing(admin, accountId, { status: "active" });

    await expect(run(manager, (db) => db.query("update public.listings set status = 'archived' where id = $1", [id]))).rejects.toThrow(/forbidden/);
    await run(admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [id]));
    const row = await listingRow(id);
    expect(row.status).toBe("archived");
    expect(row.archived_at).toBeInstanceOf(Date);

    await expect(run(admin, (db) => db.query("delete from public.listings where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [id]))).rejects.toThrow(/restored to draft first/);
    await run(admin, (db) => db.query("update public.listings set status = 'draft' where id = $1", [id]));
    expect((await listingRow(id)).archived_at).toBeNull();

    const events = await query<{ payload: { from: string; to: string } }>(
      "select payload from public.domain_events where entity_id = $1 and type = 'listing.status_changed' order by seq",
      [id],
    );
    expect(events.map((e) => `${e.payload.from}->${e.payload.to}`)).toEqual(["draft->active", "active->archived", "archived->draft"]);
  });

  it("is blocked while the listing has future bookings", async () => {
    const { accountId, admin } = await createAccount();
    const id = await bookableListing(admin, accountId, { status: "active" });
    await expect(
      withFutureBookings([id], admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [id])),
    ).rejects.toThrow(/listing_has_future_bookings/);
    // Other listings are not affected by this listing's bookings.
    const other = await bookableListing(admin, accountId);
    const archived = await withFutureBookings([id], admin, async (db) => {
      await db.query("update public.listings set status = 'archived' where id = $1", [other]);
      return (await db.query("select status from public.listings where id = $1", [other])).rows[0].status;
    });
    expect(archived).toBe("archived");
  });
});

describe("timezone changes", () => {
  it("need confirmation when the listing has future bookings", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const id = await bookableListing(admin, accountId, { status: "active" });

    // Without bookings: a plain update works.
    await run(manager, (db) => db.query("update public.listings set timezone = 'America/Chicago' where id = $1", [id]));

    await expect(
      withFutureBookings([id], manager, (db) => db.query("update public.listings set timezone = 'America/Denver' where id = $1", [id])),
    ).rejects.toThrow(/timezone_change_requires_confirmation/);
    await expect(
      withFutureBookings([id], manager, (db) => db.query("select public.change_listing_timezone($1, 'America/Denver')", [id])),
    ).rejects.toThrow(/timezone_change_requires_confirmation/);
    const tz = await withFutureBookings([id], manager, async (db) => {
      await db.query("select public.change_listing_timezone($1, 'America/Denver', true)", [id]);
      // The confirmation does not leak to later statements in the transaction.
      await db.query("savepoint s");
      await expect(db.query("update public.listings set timezone = 'America/Phoenix' where id = $1", [id])).rejects.toThrow(
        /timezone_change_requires_confirmation/,
      );
      await db.query("rollback to savepoint s");
      return (await db.query("select timezone from public.listings where id = $1", [id])).rows[0].timezone;
    });
    expect(tz).toBe("America/Denver");
  });
});

describe("cleaning status (PRP-16), tags (PRP-11) and events", () => {
  it("is per unit, defaults to clean and emits listing.cleaning_status_changed", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const frontOffice = await addMember(accountId, "front_office");
    const id = await run(admin, (db) => insertListing(db, accountId));
    const parent = await run(admin, (db) => insertListing(db, accountId, { type: "multi_parent", cleaning_status: "dirty" }));
    expect((await listingRow(id)).cleaning_status).toBe("clean");
    expect((await listingRow(parent)).cleaning_status).toBeNull();

    await run(manager, (db) => db.query("update public.listings set cleaning_status = 'dirty' where id = $1", [id]));
    const updated = await run(frontOffice, (db) => db.query("update public.listings set cleaning_status = 'clean' where id = $1", [id]));
    expect(updated.rowCount).toBe(0); // front office has properties.view only

    const events = await query<{ payload: unknown }>(
      "select payload from public.domain_events where entity_id = $1 and type = 'listing.cleaning_status_changed'",
      [id],
    );
    expect(events.map((e) => e.payload)).toEqual([{ from: "clean", to: "dirty", parent_id: null }]);
  });

  it("normalises tags", async () => {
    const { accountId, admin } = await createAccount();
    const id = await run(admin, (db) => insertListing(db, accountId, { tags: [" Miami ", "miami", "", "Pool", "POOL", "Owner: Jansen"] }));
    expect((await listingRow(id)).tags).toEqual(["Miami", "Pool", "Owner: Jansen"]);
  });

  it("keeps the account and identity of a listing fixed", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const id = await run(a.admin, (db) => insertListing(db, a.accountId));
    await expect(run(a.admin, (db) => db.query("update public.listings set account_id = $2 where id = $1", [id, b.accountId]))).rejects.toThrow();
  });
});
