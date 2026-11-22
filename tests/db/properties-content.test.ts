/**
 * Listing content tables (PRP-03 … PRP-06, PRP-17), RLS + listing scope (X-01), events (X-04)
 * and the per-listing change log (PRP-19).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { addMember, createAccount, query } from "./helpers";
import { addPhoto, bookableListing, insertListing, run } from "./properties-fixtures";

describe("rooms, amenities, descriptions (PRP-03 … PRP-05)", () => {
  it("validates beds and amenities and emits listing.content_updated", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await run(admin, (db) => insertListing(db, accountId));
    const room = await run(admin, async (db) =>
      (await db.query("insert into public.listing_rooms (account_id, listing_id, name, beds) values ($1, $2, 'Primary', $3) returning id, beds", [accountId, listing, { king: 1, single: 0 }]))
        .rows[0],
    );
    expect(room.beds).toEqual({ king: 1 });
    await expect(
      run(admin, (db) => db.query("insert into public.listing_rooms (account_id, listing_id, name, beds) values ($1, $2, 'X', $3)", [accountId, listing, { waterbed: 1 }])),
    ).rejects.toThrow(/invalid bed type/);
    await expect(
      run(admin, (db) => db.query("insert into public.listing_rooms (account_id, listing_id, name, beds) values ($1, $2, 'X', $3)", [accountId, listing, { king: 1.5 }])),
    ).rejects.toThrow(/invalid bed count/);

    await run(admin, (db) => db.query("insert into public.listing_amenities (account_id, listing_id, amenity_code) values ($1, $2, 'wifi')", [accountId, listing]));
    await run(admin, (db) => db.query("insert into public.listing_amenities (account_id, listing_id, custom_label) values ($1, $2, 'Kayaks')", [accountId, listing]));
    await expect(
      run(admin, (db) => db.query("insert into public.listing_amenities (account_id, listing_id, amenity_code) values ($1, $2, 'teleporter')", [accountId, listing])),
    ).rejects.toThrow(/foreign key/);
    await expect(
      run(admin, (db) => db.query("insert into public.listing_amenities (account_id, listing_id, custom_label) values ($1, $2, 'kayaks')", [accountId, listing])),
    ).rejects.toThrow(/duplicate key/);

    await run(admin, (db) =>
      db.query("insert into public.listing_descriptions (account_id, listing_id, language, summary) values ($1, $2, 'en', 'Hi'), ($1, $2, 'es', 'Hola')", [accountId, listing]),
    );
    await expect(
      run(admin, (db) => db.query("insert into public.listing_descriptions (account_id, listing_id, language) values ($1, $2, 'english')", [accountId, listing])),
    ).rejects.toThrow(/check constraint/);

    const sections = await query<{ section: string }>(
      "select payload->>'section' as section from public.domain_events where type = 'listing.content_updated' and entity_id = $1 order by seq",
      [listing],
    );
    expect(sections.map((s) => s.section)).toEqual(["rooms", "amenities", "amenities", "descriptions", "descriptions"]);
  });

  it("cannot attach content to another account's listing", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const theirs = await run(b.admin, (db) => insertListing(db, b.accountId));
    await expect(
      run(a.admin, (db) => db.query("insert into public.listing_descriptions (account_id, listing_id, summary) values ($1, $2, 'x')", [a.accountId, theirs])),
    ).rejects.toThrow(/foreign key|row-level security/);
    await expect(
      run(a.admin, (db) => db.query("insert into public.listing_descriptions (account_id, listing_id, summary) values ($1, $2, 'x')", [b.accountId, theirs])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("photos (PRP-06)", () => {
  it("accepts JPEG/PNG/HEIC up to 25 MB, orders them and makes the first one the cover", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await run(admin, (db) => insertListing(db, accountId));
    const ids = await run(admin, async (db) => [
      await addPhoto(db, accountId, listing),
      await addPhoto(db, accountId, listing, { content_type: "image/heic", size_bytes: 25 * 1024 * 1024 }),
      await addPhoto(db, accountId, listing, { content_type: "image/png" }),
    ]);
    await expect(run(admin, (db) => addPhoto(db, accountId, listing, { size_bytes: 25 * 1024 * 1024 + 1 }))).rejects.toThrow(/check constraint/);
    await expect(run(admin, (db) => addPhoto(db, accountId, listing, { content_type: "image/gif" }))).rejects.toThrow(/check constraint/);
    await expect(run(admin, (db) => addPhoto(db, accountId, listing, { storage_path: `${randomUUID()}/${listing}/x.jpg` }))).rejects.toThrow(
      /listing_photos_path_in_account/,
    );

    const order = async () => (await query<{ id: string }>("select id from public.listing_photos where listing_id = $1 order by position", [listing])).map((r) => r.id);
    expect(await order()).toEqual(ids);
    await run(admin, (db) => db.query("select public.reorder_listing_photos($1, $2)", [listing, [ids[2], ids[0], ids[1]]]));
    expect(await order()).toEqual([ids[2], ids[0], ids[1]]);
    await expect(run(admin, (db) => db.query("select public.reorder_listing_photos($1, $2)", [listing, [ids[0], ids[1]]]))).rejects.toThrow(/photo_order_mismatch/);
  });

  it("assigns photos only to rooms of the same listing", async () => {
    const { accountId, admin } = await createAccount();
    const [a, b] = await run(admin, async (db) => [await insertListing(db, accountId), await insertListing(db, accountId)]);
    const roomOfB = await run(admin, async (db) =>
      (await db.query("insert into public.listing_rooms (account_id, listing_id, name) values ($1, $2, 'Kitchen') returning id", [accountId, b])).rows[0].id,
    );
    await expect(run(admin, (db) => addPhoto(db, accountId, a, { room_id: roomOfB }))).rejects.toThrow(/foreign key/);
    const photo = await run(admin, (db) => addPhoto(db, accountId, b, { room_id: roomOfB }));
    await run(admin, (db) => db.query("delete from public.listing_rooms where id = $1", [roomOfB]));
    expect(await query("select room_id from public.listing_photos where id = $1", [photo])).toEqual([{ room_id: null }]);
  });

  it("checks storage paths for the storage policies", async () => {
    const { accountId, admin } = await createAccount();
    const frontOffice = await addMember(accountId, "front_office");
    const listing = await run(admin, (db) => insertListing(db, accountId));
    const check = (user: { id: string }, path: string) =>
      run(user, async (db) => (await db.query("select private.can_edit_listing_photo_path($1) as ok", [path])).rows[0].ok as boolean);
    expect(await check(admin, `${accountId}/${listing}/${randomUUID()}.jpg`)).toBe(true);
    expect(await check(frontOffice, `${accountId}/${listing}/${randomUUID()}.jpg`)).toBe(false);
    expect(await check(admin, `${accountId}/${listing}/../x.jpg`)).toBe(false);
    expect(await check(admin, `${accountId}/${listing}/x.exe`)).toBe(false);
    expect(await check(admin, `${randomUUID()}/${listing}/x.jpg`)).toBe(false);
    expect(await check(admin, `not-a-uuid/${listing}/x.jpg`)).toBe(false);
    const other = await createAccount();
    expect(await check(other.admin, `${accountId}/${listing}/${randomUUID()}.jpg`)).toBe(false);
  });
});

describe("listing scope and roles on content", () => {
  it("restricted members see content of in-scope listings only; cleaners see none", async () => {
    const { accountId, admin } = await createAccount();
    const inScope = await bookableListing(admin, accountId, { fields: { tags: ["Miami"] } });
    const outOfScope = await bookableListing(admin, accountId, { fields: { tags: ["Austin"] } });
    const manager = await addMember(accountId, "manager");
    const cleaner = await addMember(accountId, "cleaner");
    await run(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [manager.membershipId, ["miami"]]));

    const seen = await run(manager, async (db) => (await db.query("select listing_id from public.listing_photos")).rows.map((r) => r.listing_id));
    expect(seen).toEqual([inScope]);
    const edited = await run(manager, (db) => db.query("update public.listing_photos set caption = 'x' where listing_id = $1", [outOfScope]));
    expect(edited.rowCount).toBe(0);
    await expect(run(manager, (db) => addPhoto(db, accountId, outOfScope))).rejects.toThrow(/row-level security/);
    await expect(run(manager, (db) => db.query("select * from public.listing_change_log($1)", [outOfScope]))).rejects.toThrow(/not_found/);

    expect((await run(cleaner, (db) => db.query("select 1 from public.listing_photos"))).rowCount).toBe(0);
  });

  it("channel links are read-only for clients (PRP-17)", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await bookableListing(admin, accountId);
    await expect(
      run(admin, (db) => db.query("insert into public.listing_channel_links (account_id, listing_id, channel) values ($1, $2, 'booking_com')", [accountId, listing])),
    ).rejects.toThrow(/permission denied/);
    await query("insert into public.listing_channel_links (account_id, listing_id, channel, sync_mode, status, last_sync_at) values ($1, $2, 'booking_com', 'full', 'connected', now())", [
      accountId,
      listing,
    ]);
    const frontOffice = await addMember(accountId, "front_office");
    const links = await run(frontOffice, async (db) => (await db.query("select channel, sync_mode, status from public.listing_channel_links where listing_id = $1", [listing])).rows);
    expect(links).toEqual([{ channel: "booking_com", sync_mode: "full", status: "connected" }]);
  });
});

describe("change log per listing (PRP-19)", () => {
  it("shows field, old, new, user and time for the listing and its content to managers without audit.view", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    await query("update public.profiles set full_name = 'Mia Manager' where user_id = $1", [manager.id]);
    const listing = await bookableListing(admin, accountId);
    const other = await bookableListing(admin, accountId);

    await run(manager, (db) => db.query("update public.listings set base_price_cents = 21000 where id = $1", [listing]));
    const photo = (await query<{ id: string }>("select id from public.listing_photos where listing_id = $1", [listing]))[0].id;
    await run(manager, (db) => db.query("update public.listing_photos set caption = 'Ocean view' where id = $1", [photo]));
    await run(manager, (db) => db.query("delete from public.listing_photos where id = $1", [photo]));
    await run(manager, (db) => db.query("update public.listings set base_price_cents = 1 where id = $1", [other]));

    // Managers cannot read the raw audit log …
    expect((await run(manager, (db) => db.query("select 1 from public.audit_log"))).rowCount).toBe(0);
    // … but can read the listing's change log.
    const log = await run(manager, async (db) => (await db.query("select * from public.listing_change_log($1)", [listing])).rows);
    expect(log.map((r) => `${r.entity_type}:${r.action}`)).toEqual([
      "listing_photos:delete",
      "listing_photos:update",
      "listings:update",
      "listing_photos:insert",
      "listings:insert",
    ]);
    expect(log[2]).toMatchObject({ actor_type: "user", actor_name: "Mia Manager", diff: { base_price_cents: { old: 18000, new: 21000 } } });
    expect(log[1].diff).toEqual({ caption: { old: null, new: "Ocean view" } });
    expect(log[2].occurred_at).toBeInstanceOf(Date);
    expect(log.some((r) => r.entity_id === other)).toBe(false);

    const page = await run(manager, async (db) => (await db.query("select id from public.listing_change_log($1, $2, 2)", [listing, log[1].id])).rows);
    expect(page.map((r) => r.id)).toEqual([log[2].id, log[3].id]);

    const outsider = await createAccount();
    await expect(run(outsider.admin, (db) => db.query("select * from public.listing_change_log($1)", [listing]))).rejects.toThrow(/not_found/);
  });
});
