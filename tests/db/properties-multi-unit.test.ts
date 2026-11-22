/**
 * PRP-13 multi-units: structure integrity, add/remove/move/convert sub-units, status cascades,
 * content on the parent; PRP-01 duplicate; PRP-15 bulk edit.
 */
import { describe, expect, it } from "vitest";

import { addMember, createAccount, query } from "./helpers";
import { COMPLETE, addPhoto, bookableListing, insertListing, listingRow, multiUnit, run, withFutureBookings } from "./properties-fixtures";

describe("multi-unit structure (PRP-13)", () => {
  it("activates sub-units with the parent and keeps content, timezone and currency on the parent", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, subs } = await multiUnit(admin, accountId, { units: 3 });
    expect((await query("select status::text from public.listings where id = any($1)", [subs])).map((r) => r.status)).toEqual(["draft", "draft", "draft"]);

    await run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [parent]));
    for (const s of subs) expect((await listingRow(s)).status).toBe("active");

    // Sub-units carry the parent's timezone; a change on the parent propagates.
    await run(admin, (db) => db.query("update public.listings set timezone = 'America/Chicago' where id = $1", [parent]));
    for (const s of subs) expect((await listingRow(s)).timezone).toBe("America/Chicago");
    await run(admin, (db) => db.query("update public.listings set timezone = 'America/Denver' where id = $1", [subs[0]]));
    expect((await listingRow(subs[0])).timezone).toBe("America/Chicago");

    // Content lives on the parent.
    await expect(run(admin, (db) => addPhoto(db, accountId, subs[0]))).rejects.toThrow(/sub_unit_content_on_parent/);
    await expect(
      run(admin, (db) => db.query("insert into public.listing_descriptions (account_id, listing_id, summary) values ($1, $2, 'x')", [accountId, subs[0]])),
    ).rejects.toThrow(/sub_unit_content_on_parent/);

    // Cleaning status per sub-unit.
    await run(admin, (db) => db.query("update public.listings set cleaning_status = 'dirty' where id = $1", [subs[1]]));
    expect((await listingRow(subs[1])).cleaning_status).toBe("dirty");
    expect((await listingRow(subs[2])).cleaning_status).toBe("clean");
  });

  it("needs at least one sub-unit to activate a parent, and an active parent for an active sub-unit", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, subs } = await multiUnit(admin, accountId, { units: 0 }).catch(async () => {
      // add_sub_units rejects an empty list; build the bare parent by hand.
      const p = await run(admin, async (db) => {
        const id = await insertListing(db, accountId, { ...COMPLETE, type: "multi_parent" });
        await addPhoto(db, accountId, id);
        return id;
      });
      return { parent: p, subs: [] as string[] };
    });
    expect(subs).toEqual([]);
    await expect(run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [parent]))).rejects.toThrow(
      /listing_not_activatable: sub_units/,
    );
    const [sub] = await run(admin, async (db) => (await db.query("select * from public.add_sub_units($1, $2) as id", [parent, ["A"]])).rows.map((r) => r.id));
    await expect(run(admin, (db) => db.query("update public.listings set status = 'active' where id = $1", [sub]))).rejects.toThrow(
      /listing_not_activatable: parent_not_active/,
    );
  });

  it("only admins add sub-units; sub-units of an active parent start active", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const { parent } = await multiUnit(admin, accountId, { units: 1, status: "active" });
    await expect(run(manager, (db) => db.query("select public.add_sub_units($1, $2)", [parent, ["X"]]))).rejects.toThrow(/forbidden/);
    const ids = await run(admin, async (db) => (await db.query("select * from public.add_sub_units($1, $2) as id", [parent, ["B", "C"]])).rows.map((r) => r.id));
    for (const id of ids) expect((await listingRow(id)).status).toBe("active");
    const single = await bookableListing(admin, accountId);
    await expect(run(admin, (db) => db.query("select public.add_sub_units($1, $2)", [single, ["X"]]))).rejects.toThrow(/not_a_multi_unit_parent/);
  });

  it("removes a sub-unit by archiving it, but not the last one of an active parent", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, subs } = await multiUnit(admin, accountId, { units: 2, status: "active" });
    await run(admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [subs[0]]));
    await expect(run(admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [subs[1]]))).rejects.toThrow(
      /listing_not_activatable: sub_units/,
    );
    await expect(
      withFutureBookings([subs[1]], admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [subs[1]])),
    ).rejects.toThrow(/listing_has_future_bookings/);

    // Archiving the parent archives its remaining sub-units.
    await run(admin, (db) => db.query("update public.listings set status = 'archived' where id = $1", [parent]));
    expect((await listingRow(subs[1])).status).toBe("archived");
    // An archived parent takes no new sub-units, and archived sub-units cannot be restored under it.
    await expect(run(admin, (db) => db.query("select public.add_sub_units($1, $2)", [parent, ["Z"]]))).rejects.toThrow(/parent_archived/);
    await expect(run(admin, (db) => db.query("update public.listings set status = 'draft' where id = $1", [subs[1]]))).rejects.toThrow(/parent_archived/);
  });

  it("moves a sub-unit between parents (admins only, not with future bookings, not to an archived parent)", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const a = await multiUnit(admin, accountId, { units: 2, status: "active" });
    const b = await multiUnit(admin, accountId, { units: 1 });
    await run(admin, (db) => db.query("update public.listings set timezone = 'America/Los_Angeles' where id = $1", [b.parent]));

    await expect(run(manager, (db) => db.query("select public.move_sub_unit($1, $2)", [a.subs[0], b.parent]))).rejects.toThrow(/forbidden/);
    await expect(run(manager, (db) => db.query("update public.listings set parent_id = $2 where id = $1", [a.subs[0], b.parent]))).rejects.toThrow(/forbidden/);
    await expect(
      withFutureBookings([a.subs[0]], admin, (db) => db.query("select public.move_sub_unit($1, $2)", [a.subs[0], b.parent])),
    ).rejects.toThrow(/listing_has_future_bookings/);

    await run(admin, (db) => db.query("update public.listings set cleaning_status = 'dirty' where id = $1", [a.subs[0]]));
    await run(admin, (db) => db.query("select public.move_sub_unit($1, $2)", [a.subs[0], b.parent]));
    const moved = await listingRow(a.subs[0]);
    expect(moved).toMatchObject({ parent_id: b.parent, status: "draft", timezone: "America/Los_Angeles", cleaning_status: "dirty" });

    // The last sub-unit of an active parent cannot leave.
    await expect(run(admin, (db) => db.query("select public.move_sub_unit($1, $2)", [a.subs[1], b.parent]))).rejects.toThrow(/listing_not_activatable: sub_units/);

    const single = await bookableListing(admin, accountId);
    await expect(run(admin, (db) => db.query("select public.move_sub_unit($1, $2)", [a.subs[1], single]))).rejects.toThrow(/not_a_multi_unit_parent/);
    // Other type changes are not allowed.
    await expect(run(admin, (db) => db.query("update public.listings set type = 'multi_parent' where id = $1", [single]))).rejects.toThrow(
      /listing_type_change_not_allowed/,
    );
  });

  it("converts a sub-unit into a complete single unit", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, subs } = await multiUnit(admin, accountId, { units: 2, status: "active", tags: ["Miami"] });
    await run(admin, async (db) => {
      await db.query("insert into public.listing_descriptions (account_id, listing_id, summary) values ($1, $2, 'Sunny studio')", [accountId, parent]);
      const { rows } = await db.query("insert into public.listing_rooms (account_id, listing_id, name, beds) values ($1, $2, 'Bedroom', '{\"queen\": 1}') returning id", [
        accountId,
        parent,
      ]);
      await db.query("update public.listing_photos set room_id = $2 where listing_id = $1", [parent, rows[0].id]);
      await db.query("insert into public.listing_amenities (account_id, listing_id, amenity_code) values ($1, $2, 'wifi')", [accountId, parent]);
    });
    await expect(withFutureBookings([subs[0]], admin, (db) => db.query("select public.convert_sub_unit_to_single($1)", [subs[0]]))).rejects.toThrow(
      /listing_has_future_bookings/,
    );

    await run(admin, (db) => db.query("select public.convert_sub_unit_to_single($1)", [subs[0]]));
    const unit = await listingRow(subs[0]);
    expect(unit).toMatchObject({ type: "single", parent_id: null, status: "active", base_price_cents: 18000, city: "Miami Beach", tags: ["Miami"] });
    const [photo] = await query("select p.storage_path, r.name as room from public.listing_photos p left join public.listing_rooms r on r.id = p.room_id where p.listing_id = $1", [
      subs[0],
    ]);
    expect(photo.room).toBe("Bedroom");
    expect(await query("select summary from public.listing_descriptions where listing_id = $1", [subs[0]])).toEqual([{ summary: "Sunny studio" }]);
    expect(await query("select amenity_code from public.listing_amenities where listing_id = $1", [subs[0]])).toEqual([{ amenity_code: "wifi" }]);
    // The parent still has its other sub-unit and its own content.
    expect((await listingRow(parent)).status).toBe("active");
  });
});

describe("duplicate (PRP-01)", () => {
  it("copies content and prices into a new draft; a parent comes with its sub-units", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const single = await bookableListing(admin, accountId, { status: "active", fields: { tags: ["Pool"] } });
    await expect(run(manager, (db) => db.query("select public.duplicate_listing($1)", [single]))).rejects.toThrow(/forbidden/);

    const copy = await run(admin, async (db) => (await db.query("select public.duplicate_listing($1) as id", [single])).rows[0].id as string);
    const row = await listingRow(copy);
    expect(row).toMatchObject({ status: "draft", type: "single", base_price_cents: 18000, tags: ["Pool"] });
    expect(row.internal_name).toMatch(/\(copy\)$/);
    expect(await query("select count(*)::int as n from public.listing_photos where listing_id = $1", [copy])).toEqual([{ n: 1 }]);

    const { parent } = await multiUnit(admin, accountId, { units: 2, status: "active" });
    const parentCopy = await run(admin, async (db) => (await db.query("select public.duplicate_listing($1, 'Studios B') as id", [parent])).rows[0].id as string);
    expect((await listingRow(parentCopy)).internal_name).toBe("Studios B");
    expect(await query("select internal_name, status::text from public.listings where parent_id = $1 order by internal_name", [parentCopy])).toEqual([
      { internal_name: "Studio 1", status: "draft" },
      { internal_name: "Studio 2", status: "draft" },
    ]);
  });
});

describe("bulk edit (PRP-15)", () => {
  it("updates prices, rules, fees, times, tags and amenities across a selection atomically", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const one = await bookableListing(admin, accountId, { fields: { tags: ["Miami", "Old"] } });
    const two = await bookableListing(admin, accountId, { fields: { tags: ["Austin"] } });

    const count = await run(manager, async (db) =>
      (
        await db.query("select public.bulk_update_listings($1, $2) as n", [
          [one, two],
          { base_price_cents: 20000, min_nights: 2, cleaning_fee_cents: 9000, check_in_from: "15:00", add_tags: ["Pool"], remove_tags: ["old"], add_amenities: ["wifi", "pool"] },
        ])
      ).rows[0].n,
    );
    expect(count).toBe(2);
    expect(await listingRow(one)).toMatchObject({ base_price_cents: 20000, min_nights: 2, cleaning_fee_cents: 9000, check_in_from: "15:00:00", tags: ["Miami", "Pool"] });
    expect((await listingRow(two)).tags).toEqual(["Austin", "Pool"]);
    expect(await query("select count(*)::int as n from public.listing_amenities where listing_id = any($1)", [[one, two]])).toEqual([{ n: 4 }]);

    await run(manager, (db) => db.query("select public.bulk_update_listings($1, $2)", [[one, two], { remove_amenities: ["pool"] }]));
    expect(await query("select count(*)::int as n from public.listing_amenities where listing_id = any($1)", [[one, two]])).toEqual([{ n: 2 }]);

    // All or nothing: an invalid value for one row rolls back the whole selection.
    await expect(run(manager, (db) => db.query("select public.bulk_update_listings($1, $2)", [[one, two], { min_nights: 5, max_nights: 3 }]))).rejects.toThrow(
      /listings_min_le_max/,
    );
    expect((await listingRow(one)).min_nights).toBe(2);
    await expect(run(manager, (db) => db.query("select public.bulk_update_listings($1, $2)", [[one], { status: "archived" }]))).rejects.toThrow(/bulk_invalid_changes/);
  });

  it("rejects listings the caller cannot see and price edits on sub-units", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const mine = await bookableListing(a.admin, a.accountId);
    const theirs = await bookableListing(b.admin, b.accountId);
    await expect(run(a.admin, (db) => db.query("select public.bulk_update_listings($1, $2)", [[mine, theirs], { min_nights: 3 }]))).rejects.toThrow(/not_found/);
    expect((await listingRow(theirs)).min_nights).toBe(1);

    const frontOffice = await addMember(a.accountId, "front_office");
    await expect(run(frontOffice, (db) => db.query("select public.bulk_update_listings($1, $2)", [[mine], { min_nights: 3 }]))).rejects.toThrow(/forbidden/);

    const { subs } = await multiUnit(a.admin, a.accountId, { units: 1 });
    await expect(run(a.admin, (db) => db.query("select public.bulk_update_listings($1, $2)", [[mine, subs[0]], { base_price_cents: 1 }]))).rejects.toThrow(
      /sub_units_inherit_from_parent/,
    );
    await run(a.admin, (db) => db.query("select public.bulk_update_listings($1, $2)", [[mine, subs[0]], { add_tags: ["Beach"] }]));
    expect((await listingRow(subs[0])).tags).toEqual(["Beach"]);
  });
});
