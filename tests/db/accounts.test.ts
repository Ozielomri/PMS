/**
 * X-01 / X-02: account creation, invitations, membership management, last-admin guard.
 */
import { describe, expect, it } from "vitest";

import { addMember, as, asUser, createAccount, createUser, query } from "./helpers";

async function invite(admin: { id: string }, accountId: string, email: string, role = "cleaner") {
  return asUser(admin, async (db) => {
    const { rows } = await db.query("select * from public.create_invitation($1, $2, $3)", [accountId, email, role]);
    return rows[0] as { invitation_id: string; token: string; expires_at: Date };
  });
}

describe("create_account", () => {
  it("makes the caller the first admin and syncs their profile", async () => {
    const user = await createUser({ fullName: "Dana Owner" });
    const accountId = await as({ userId: user.id, aal: "aal1" }, async (db) => {
      const { rows } = await db.query("select public.create_account('Harbor View', 'America/Chicago') as id");
      return rows[0].id as string;
    });
    const [account] = await query("select name, timezone, currency, created_by from public.accounts where id = $1", [accountId]);
    expect(account).toEqual({ name: "Harbor View", timezone: "America/Chicago", currency: "USD", created_by: user.id });
    const [membership] = await query("select role::text, status, listing_scope from public.memberships where account_id = $1", [accountId]);
    expect(membership).toEqual({ role: "admin", status: "active", listing_scope: "all" });
    const [profile] = await query("select email, full_name from public.profiles where user_id = $1", [user.id]);
    expect(profile).toEqual({ email: user.email, full_name: "Dana Owner" });
  });

  it("rejects anonymous callers and invalid timezones", async () => {
    await expect(as({ role: "anon" }, (db) => db.query("select public.create_account('X')"))).rejects.toThrow(/permission denied/);
    const user = await createUser();
    await expect(asUser(user, (db) => db.query("select public.create_account('X', 'Mars/Olympus')"))).rejects.toThrow(/invalid timezone/);
  });

  it("lets an aal1 admin see their account and membership but change nothing (MFA gate)", async () => {
    const { accountId, admin } = await createAccount();
    const result = await asUser(
      admin,
      async (db) => {
        const accounts = await db.query("select id from public.accounts");
        const memberships = await db.query("select role::text from public.memberships");
        const updated = await db.query("update public.accounts set name = 'Hacked' where id = $1", [accountId]);
        return { accounts: accounts.rowCount, role: memberships.rows[0]?.role, updated: updated.rowCount };
      },
      { aal: "aal1" },
    );
    expect(result).toEqual({ accounts: 1, role: "admin", updated: 0 });

    const updated = await asUser(admin, (db) => db.query("update public.accounts set name = 'Renamed' where id = $1", [accountId]));
    expect(updated.rowCount).toBe(1);
  });
});

describe("invitations", () => {
  it("can only be created by users with account.manage_users", async () => {
    const { accountId } = await createAccount();
    const manager = await addMember(accountId, "manager");
    await expect(invite(manager, accountId, "new@example.test")).rejects.toThrow(/forbidden/);
  });

  it("stores only a hash of the token and previews publicly by token", async () => {
    const { accountId, admin } = await createAccount("Preview Rentals");
    const { token } = await invite(admin, accountId, "  Guest.Cleaner@Example.test ", "cleaner");
    const stored = await query<{ token_hash: string; email: string }>("select token_hash, email from public.invitations where account_id = $1", [accountId]);
    expect(stored[0].token_hash).not.toContain(token);
    expect(stored[0].email).toBe("guest.cleaner@example.test");

    const preview = await as({ role: "anon" }, (db) => db.query("select * from public.get_invitation($1)", [token]));
    expect(preview.rows[0]).toMatchObject({ account_name: "Preview Rentals", role: "cleaner", status: "pending" });
    const none = await as({ role: "anon" }, (db) => db.query("select * from public.get_invitation('nope')"));
    expect(none.rowCount).toBe(0);
  });

  it("creates a membership with the invited role when the right user accepts", async () => {
    const { accountId, admin } = await createAccount();
    const invitee = await createUser({ email: "frontdesk@example.test" });
    const { token } = await invite(admin, accountId, "FrontDesk@example.test", "front_office");

    const membershipId = await asUser(invitee, async (db) => (await db.query("select public.accept_invitation($1) as id", [token])).rows[0].id);
    const [m] = await query("select account_id, user_id, role::text, status, invited_by from public.memberships where id = $1", [membershipId]);
    expect(m).toEqual({ account_id: accountId, user_id: invitee.id, role: "front_office", status: "active", invited_by: admin.id });

    await expect(asUser(invitee, (db) => db.query("select public.accept_invitation($1)", [token]))).rejects.toThrow(/invitation_invalid/);
  });

  it("rejects the wrong email, expired and revoked invitations", async () => {
    const { accountId, admin } = await createAccount();
    const stranger = await createUser();
    const { token, invitation_id } = await invite(admin, accountId, "someone@example.test");
    await expect(asUser(stranger, (db) => db.query("select public.accept_invitation($1)", [token]))).rejects.toThrow(/invitation_email_mismatch/);

    const target = await createUser({ email: "late@example.test" });
    const late = await invite(admin, accountId, "late@example.test");
    await query("update public.invitations set expires_at = now() - interval '1 minute' where id = $1", [late.invitation_id]);
    await expect(asUser(target, (db) => db.query("select public.accept_invitation($1)", [late.token]))).rejects.toThrow(/invitation_expired/);

    await asUser(admin, (db) => db.query("update public.invitations set revoked_at = now() where id = $1", [invitation_id]));
    const someone = await createUser({ email: "someone@example.test" });
    await expect(asUser(someone, (db) => db.query("select public.accept_invitation($1)", [token]))).rejects.toThrow(/invitation_invalid/);
  });

  it("re-inviting the same email revokes the previous pending invitation", async () => {
    const { accountId, admin } = await createAccount();
    const first = await invite(admin, accountId, "twice@example.test");
    await invite(admin, accountId, "twice@example.test", "manager");
    const [row] = await query("select revoked_at is not null as revoked from public.invitations where id = $1", [first.invitation_id]);
    expect(row.revoked).toBe(true);
  });

  it("refuses to invite an existing active member", async () => {
    const { accountId, admin } = await createAccount();
    await expect(invite(admin, accountId, admin.email)).rejects.toThrow(/already_member/);
  });

  it("reactivates a removed member who is invited again", async () => {
    const { accountId, admin } = await createAccount();
    const member = await addMember(accountId, "cleaner", { status: "removed" });
    const { token } = await invite(admin, accountId, member.email, "supervisor");
    await asUser(member, (db) => db.query("select public.accept_invitation($1)", [token]));
    const [m] = await query("select role::text, status from public.memberships where id = $1", [member.membershipId]);
    expect(m).toEqual({ role: "supervisor", status: "active" });
  });
});

describe("membership management", () => {
  it("lets admins change roles and status; others cannot", async () => {
    const { accountId, admin } = await createAccount();
    const cleaner = await addMember(accountId, "cleaner");
    const manager = await addMember(accountId, "manager");

    const byManager = await asUser(manager, (db) => db.query("update public.memberships set role = 'admin' where id = $1", [cleaner.membershipId]));
    expect(byManager.rowCount).toBe(0);

    const byAdmin = await asUser(admin, (db) => db.query("update public.memberships set role = 'supervisor' where id = $1", [cleaner.membershipId]));
    expect(byAdmin.rowCount).toBe(1);
  });

  it("does not let clients move a membership to another account or user", async () => {
    const { accountId, admin } = await createAccount();
    const other = await createAccount();
    const member = await addMember(accountId, "cleaner");
    await expect(
      asUser(admin, (db) => db.query("update public.memberships set account_id = $1 where id = $2", [other.accountId, member.membershipId])),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps at least one active admin", async () => {
    const { accountId, admin } = await createAccount();
    const [own] = await query<{ id: string }>("select id from public.memberships where account_id = $1 and user_id = $2", [accountId, admin.id]);
    for (const change of ["role = 'manager'", "status = 'suspended'", "status = 'removed'"]) {
      await expect(asUser(admin, (db) => db.query(`update public.memberships set ${change} where id = $1`, [own.id]))).rejects.toThrow(/last_admin/);
    }

    const second = await addMember(accountId, "admin");
    const demoted = await asUser(admin, (db) => db.query("update public.memberships set role = 'manager' where id = $1", [own.id]));
    expect(demoted.rowCount).toBe(1);
    await expect(
      asUser(second, (db) => db.query("update public.memberships set status = 'removed' where id = $1", [second.membershipId])),
    ).rejects.toThrow(/last_admin/);
  });

  it("lists the whole team for members with account.view, only themselves otherwise", async () => {
    const { accountId, admin } = await createAccount();
    const cleaner = await addMember(accountId, "cleaner");
    const count = (u: { id: string }, aal: "aal1" | "aal2") =>
      asUser(u, async (db) => (await db.query("select count(*)::int as n from public.memberships where account_id = $1", [accountId])).rows[0].n, { aal });
    expect(await count(cleaner, "aal1")).toBe(2);
    expect(await count(admin, "aal1")).toBe(1); // unverified admin: own membership only
    expect(await count(admin, "aal2")).toBe(2);
  });
});
