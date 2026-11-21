/**
 * X-01: role permissions and listing scope, as enforced by the database.
 */
import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS, ROLES, ROLE_PERMISSIONS, can, type Role } from "@/lib/auth/permissions";

import { addMember, asUser, createAccount, query } from "./helpers";

async function hasPermission(user: { id: string }, accountId: string, permission: string, aal: "aal1" | "aal2" = "aal2") {
  return asUser(
    user,
    async (db) => (await db.query("select private.has_permission($1, $2) as ok", [accountId, permission])).rows[0].ok as boolean,
    { aal },
  );
}

describe("role_permissions matrix", () => {
  it("is identical to the TypeScript matrix in src/lib/auth/permissions.ts", async () => {
    const rows = await query<{ role: Role; permission: string }>("select role::text as role, permission from public.role_permissions");
    const db = Object.fromEntries(ROLES.map((r) => [r, rows.filter((x) => x.role === r).map((x) => x.permission).sort()]));
    const ts = Object.fromEntries(ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]].sort()]));
    expect(db).toEqual(ts);
  });

  it("only uses known permission keys", async () => {
    const rows = await query<{ permission: string }>("select distinct permission from public.role_permissions");
    for (const { permission } of rows) expect(ALL_PERMISSIONS).toContain(permission);
  });
});

describe("private.has_permission", () => {
  it("matches can() for every role and permission (aal2)", async () => {
    const { accountId } = await createAccount();
    for (const role of ROLES.filter((r) => r !== "admin")) {
      const member = await addMember(accountId, role);
      const results = await asUser(member, async (db) => {
        const { rows } = await db.query<{ permission: string; ok: boolean }>(
          "select p as permission, private.has_permission($1, p) as ok from unnest($2::text[]) p",
          [accountId, ALL_PERMISSIONS],
        );
        return rows;
      });
      for (const { permission, ok } of results) {
        expect([role, permission, ok]).toEqual([role, permission, can({ role }, permission as never, "aal2")]);
      }
    }
  });

  it("gives an admin every permission only once the session is TOTP-verified (X-02)", async () => {
    const { accountId, admin } = await createAccount();
    expect(await hasPermission(admin, accountId, "account.manage_users", "aal2")).toBe(true);
    expect(await hasPermission(admin, accountId, "account.manage_users", "aal1")).toBe(false);
    expect(await hasPermission(admin, accountId, "account.view", "aal1")).toBe(false);
  });

  it("does not require aal2 for non-admin roles", async () => {
    const { accountId } = await createAccount();
    const manager = await addMember(accountId, "manager");
    expect(await hasPermission(manager, accountId, "reservations.cancel", "aal1")).toBe(true);
  });

  it("denies suspended and removed members and non-members", async () => {
    const { accountId } = await createAccount();
    const suspended = await addMember(accountId, "manager", { status: "suspended" });
    const removed = await addMember(accountId, "manager", { status: "removed" });
    const other = await createAccount();
    expect(await hasPermission(suspended, accountId, "account.view")).toBe(false);
    expect(await hasPermission(removed, accountId, "account.view")).toBe(false);
    expect(await hasPermission(other.admin, accountId, "account.view")).toBe(false);
  });

  it("spot-checks the requirements table", async () => {
    const { accountId } = await createAccount();
    const fo = await addMember(accountId, "front_office");
    const supervisor = await addMember(accountId, "supervisor");
    const cleaner = await addMember(accountId, "cleaner");
    // Front office: calendar "block only", reservations "create, edit, no cancel"
    expect(await hasPermission(fo, accountId, "calendar.block")).toBe(true);
    expect(await hasPermission(fo, accountId, "calendar.edit")).toBe(false);
    expect(await hasPermission(fo, accountId, "reservations.edit")).toBe(true);
    expect(await hasPermission(fo, accountId, "reservations.cancel")).toBe(false);
    // Supervisor: reservations "view (no money)", automations "none"
    expect(await hasPermission(supervisor, accountId, "reservations.view")).toBe(true);
    expect(await hasPermission(supervisor, accountId, "reservations.view_money")).toBe(false);
    expect(await hasPermission(supervisor, accountId, "automations.view")).toBe(false);
    // Cleaner: calendar "none", tasks "own only"
    expect(await hasPermission(cleaner, accountId, "calendar.view")).toBe(false);
    expect(await hasPermission(cleaner, accountId, "tasks.view")).toBe(false);
    expect(await hasPermission(cleaner, accountId, "tasks.update_own")).toBe(true);
  });
});

describe("listing scope (X-01)", () => {
  const LISTING_A = "00000000-0000-4000-8000-00000000000a";
  const LISTING_B = "00000000-0000-4000-8000-00000000000b";

  async function canAccess(user: { id: string }, accountId: string, listingId: string, tags: string[]) {
    return asUser(
      user,
      async (db) =>
        (await db.query("select private.can_access_listing($1, $2, $3) as ok", [accountId, listingId, tags])).rows[0].ok as boolean,
    );
  }

  it("lets 'all' members see every listing of their account only", async () => {
    const { accountId } = await createAccount();
    const other = await createAccount();
    const manager = await addMember(accountId, "manager");
    expect(await canAccess(manager, accountId, LISTING_A, [])).toBe(true);
    expect(await canAccess(manager, other.accountId, LISTING_A, [])).toBe(false);
  });

  it("restricts to matching tags (case-insensitive) or listing ids", async () => {
    const { accountId, admin } = await createAccount();
    const cleaner = await addMember(accountId, "cleaner");
    await asUser(admin, (db) =>
      db.query("select public.set_membership_listing_scope($1, 'restricted', $2, $3)", [cleaner.membershipId, ["Amsterdam"], [LISTING_B]]),
    );
    expect(await canAccess(cleaner, accountId, LISTING_A, ["amsterdam", "Pool"])).toBe(true);
    expect(await canAccess(cleaner, accountId, LISTING_A, ["Rotterdam"])).toBe(false);
    expect(await canAccess(cleaner, accountId, LISTING_B, [])).toBe(true);

    const scopes = await query("select kind, value from public.membership_listing_scopes where membership_id = $1 order by kind", [
      cleaner.membershipId,
    ]);
    expect(scopes).toEqual([
      { kind: "listing", value: LISTING_B },
      { kind: "tag", value: "Amsterdam" },
    ]);
  });

  it("replaces the scope atomically and clears it when set back to all", async () => {
    const { accountId, admin } = await createAccount();
    const member = await addMember(accountId, "front_office");
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [member.membershipId, ["A", "B"]]));
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'all')", [member.membershipId]));
    expect(await query("select 1 from public.membership_listing_scopes where membership_id = $1", [member.membershipId])).toHaveLength(0);
    expect(await canAccess(member, accountId, LISTING_A, [])).toBe(true);
  });

  it("only lets users with account.manage_users change scopes", async () => {
    const { accountId } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const cleaner = await addMember(accountId, "cleaner");
    await expect(
      asUser(manager, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [cleaner.membershipId, ["X"]])),
    ).rejects.toThrow(/forbidden/);
  });

  it("never restricts an admin", async () => {
    const { accountId, admin } = await createAccount();
    const [m] = await query<{ id: string }>("select id from public.memberships where account_id = $1 and user_id = $2", [accountId, admin.id]);
    await expect(
      asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [m.id, ["X"]])),
    ).rejects.toThrow(/admins_see_all_listings/);
  });
});
