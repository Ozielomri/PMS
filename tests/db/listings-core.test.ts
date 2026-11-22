/** Contract table for steps 2 + 3: integrity rules and RLS of public.listings. */
import { describe, expect, it } from "vitest";

import { addMember, asUser, createAccount, query } from "./helpers";

async function insertListing(user: { id: string }, accountId: string, fields: Record<string, unknown> = {}) {
  const cols = { account_id: accountId, internal_name: "Unit", ...fields };
  const keys = Object.keys(cols);
  return asUser(user, async (db) => {
    const { rows } = await db.query(
      `insert into public.listings (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(cols),
    );
    return rows[0].id as string;
  });
}

describe("listings (core contract)", () => {
  it("only admins create listings; managers edit; cleaners cannot see them", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const cleaner = await addMember(accountId, "cleaner");
    await expect(insertListing(manager, accountId)).rejects.toThrow(/row-level security/);
    const id = await insertListing(admin, accountId, { base_price_cents: 15000 });

    const edited = await asUser(manager, (db) => db.query("update public.listings set base_price_cents = 18000 where id = $1", [id]));
    expect(edited.rowCount).toBe(1);
    const seen = await asUser(cleaner, (db) => db.query("select id from public.listings where id = $1", [id]));
    expect(seen.rowCount).toBe(0);
  });

  it("enforces multi-unit structure and valid rules", async () => {
    const { accountId, admin } = await createAccount();
    const single = await insertListing(admin, accountId);
    const parent = await insertListing(admin, accountId, { type: "multi_parent" });
    await insertListing(admin, accountId, { type: "sub_unit", parent_id: parent });
    await expect(insertListing(admin, accountId, { type: "sub_unit", parent_id: single })).rejects.toThrow(/multi_parent/);
    await expect(insertListing(admin, accountId, { type: "sub_unit" })).rejects.toThrow(/listings_parent_matches_type/);
    await expect(insertListing(admin, accountId, { min_nights: 5, max_nights: 2 })).rejects.toThrow(/listings_min_le_max/);
    await expect(insertListing(admin, accountId, { timezone: "Nowhere/Land" })).rejects.toThrow(/invalid timezone/);
  });

  it("applies listing scope, including tags inherited from the parent", async () => {
    const { accountId, admin } = await createAccount();
    const parent = await insertListing(admin, accountId, { type: "multi_parent", tags: ["Miami"] });
    const sub = await insertListing(admin, accountId, { type: "sub_unit", parent_id: parent });
    const other = await insertListing(admin, accountId, { tags: ["Austin"] });
    const fo = await addMember(accountId, "front_office");
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [fo.membershipId, ["miami"]]));
    const ids = await asUser(fo, async (db) => (await db.query("select id from public.listings")).rows.map((r) => r.id));
    expect(ids.sort()).toEqual([parent, sub].sort());
    expect(ids).not.toContain(other);
  });

  it("is audited and emits listing events", async () => {
    const { accountId, admin } = await createAccount();
    const id = await insertListing(admin, accountId);
    await asUser(admin, (db) => db.query("update public.listings set min_nights = 3 where id = $1", [id]));
    const events = await query("select type, payload->'changes' as changes from public.domain_events where entity_id = $1 order by seq", [id]);
    expect(events).toEqual([
      { type: "listing.created", changes: null },
      { type: "listing.updated", changes: { min_nights: { old: 1, new: 3 } } },
    ]);
    expect(await query("select action from public.audit_log where entity_id = $1 order by id", [id])).toEqual([{ action: "insert" }, { action: "update" }]);
  });
});
