/**
 * X-03 audit log: actor, entity, diff, timestamp, IP; append-only; secrets redacted; 2-year retention.
 */
import { describe, expect, it } from "vitest";

import { addMember, as, asSystem, asUser, createAccount, query } from "./helpers";

interface AuditRow {
  id: number;
  account_id: string;
  actor_type: string;
  actor_id: string | null;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  diff: Record<string, { old?: unknown; new?: unknown }>;
  ip: string | null;
  request_id: string | null;
  occurred_at: Date;
}

const auditFor = (entityId: string) => query<AuditRow>("select * from public.audit_log where entity_id = $1 order by id", [entityId]);

describe("audit trigger", () => {
  it("records insert, update and delete with field-level diffs", async () => {
    const { accountId, admin } = await createAccount("Before");
    await asUser(admin, (db) => db.query("update public.accounts set name = 'After' where id = $1", [accountId]));

    const rows = await auditFor(accountId);
    expect(rows.map((r) => r.action)).toEqual(["insert", "update"]);
    expect(rows[0].diff.name).toEqual({ new: "Before" });
    expect(rows[1].diff).toEqual({ name: { old: "Before", new: "After" } });
    expect(rows[1].account_id).toBe(accountId);
    expect(rows[1].entity_type).toBe("accounts");
    expect(rows[1].occurred_at).toBeInstanceOf(Date);

    // Deletes are audited too (listing scopes are config rows that can be deleted).
    const cleaner = await addMember(accountId, "cleaner");
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [cleaner.membershipId, ["Pool"]]));
    const [scope] = await query<{ id: string }>("select id from public.membership_listing_scopes where membership_id = $1", [cleaner.membershipId]);
    await asUser(admin, (db) => db.query("select public.set_membership_listing_scope($1, 'all')", [cleaner.membershipId]));
    const scopeRows = await auditFor(scope.id);
    expect(scopeRows.map((r) => r.action)).toEqual(["insert", "delete"]);
    expect(scopeRows[1].diff.value).toEqual({ old: "Pool" });
  });

  it("captures the user, the client IP and the request id", async () => {
    const { accountId, admin } = await createAccount();
    await as(
      { userId: admin.id, aal: "aal2", headers: { "x-pms-client-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.1", "x-request-id": "req-123" } },
      (db) => db.query("update public.accounts set name = 'With IP' where id = $1", [accountId]),
    );
    const last = (await auditFor(accountId)).at(-1)!;
    expect(last).toMatchObject({ actor_type: "user", actor_id: admin.id, actor_user_id: admin.id, ip: "203.0.113.7", request_id: "req-123" });
  });

  it("falls back to the first x-forwarded-for hop", async () => {
    const { accountId, admin } = await createAccount();
    await as({ userId: admin.id, aal: "aal2", headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" } }, (db) =>
      db.query("update public.accounts set name = 'XFF' where id = $1", [accountId]),
    );
    expect((await auditFor(accountId)).at(-1)!.ip).toBe("198.51.100.4");
  });

  it("attributes service-role changes to the declared non-user actor", async () => {
    const { accountId } = await createAccount();
    await as({ role: "service_role", headers: { "x-pms-actor-type": "channel", "x-pms-actor-id": "booking_com" } }, (db) =>
      db.query("update public.accounts set name = 'From channel' where id = $1", [accountId]),
    );
    expect((await auditFor(accountId)).at(-1)).toMatchObject({ actor_type: "channel", actor_id: "booking_com", actor_user_id: null });

    await asSystem(async (db) => {
      await db.query("select set_config('pms.actor_type', 'automation', true), set_config('pms.actor_id', 'rule-42', true)");
      await db.query("update public.accounts set name = 'From automation' where id = $1", [accountId]);
    });
    expect((await auditFor(accountId)).at(-1)).toMatchObject({ actor_type: "automation", actor_id: "rule-42" });

    await asSystem((db) => db.query("update public.accounts set name = 'From SQL' where id = $1", [accountId]));
    expect((await auditFor(accountId)).at(-1)).toMatchObject({ actor_type: "system" });
  });

  it("ignores actor headers sent by signed-in users", async () => {
    const { accountId, admin } = await createAccount();
    await as({ userId: admin.id, aal: "aal2", headers: { "x-pms-actor-type": "automation" } }, (db) =>
      db.query("update public.accounts set name = 'Spoof' where id = $1", [accountId]),
    );
    expect((await auditFor(accountId)).at(-1)).toMatchObject({ actor_type: "user", actor_id: admin.id });
  });

  it("redacts secret columns but still records that they changed", async () => {
    const { accountId, admin } = await createAccount();
    const { rows } = await asUser(admin, (db) =>
      db.query(
        "insert into public.webhook_endpoints (account_id, url, secret_ciphertext, secret_last4) values ($1, 'https://example.com/a', 'v1.secret.one.x', 'aaaa') returning id",
        [accountId],
      ),
    );
    const endpointId = rows[0].id as string;
    await asUser(admin, (db) =>
      db.query("update public.webhook_endpoints set secret_ciphertext = 'v1.secret.two.x', secret_last4 = 'bbbb' where id = $1", [endpointId]),
    );
    const audit = await auditFor(endpointId);
    expect(JSON.stringify(audit)).not.toContain("v1.secret");
    expect(audit[0].diff.secret_ciphertext).toEqual({ new: "[redacted]" });
    expect(audit[1].diff.secret_ciphertext).toEqual({ old: "[redacted]", new: "[redacted]" });
    expect(audit[1].diff.secret_last4).toEqual({ old: "aaaa", new: "bbbb" });

    const inv = await asUser(admin, (db) => db.query("select * from public.create_invitation($1, 'r@example.test', 'manager')", [accountId]));
    const invAudit = await auditFor(inv.rows[0].invitation_id);
    expect(invAudit[0].diff.token_hash).toEqual({ new: "[redacted]" });
  });

  it("skips updates that change nothing but updated_at", async () => {
    const { accountId, admin } = await createAccount();
    const before = (await auditFor(accountId)).length;
    await asUser(admin, (db) => db.query("update public.accounts set name = name where id = $1", [accountId]));
    expect((await auditFor(accountId)).length).toBe(before);
  });
});

describe("audit_log table", () => {
  it("is append-only, even for the database owner", async () => {
    const { accountId } = await createAccount();
    await expect(query("update public.audit_log set action = 'delete' where account_id = $1", [accountId])).rejects.toThrow(/append-only/);
    await expect(query("delete from public.audit_log where account_id = $1", [accountId])).rejects.toThrow(/append-only/);
    await expect(query("truncate public.audit_log")).rejects.toThrow(/append-only/);
  });

  it("is readable only with audit.view, within the account", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const count = (u: { id: string }) =>
      asUser(u, async (db) => (await db.query("select count(*)::int as n from public.audit_log where account_id = $1", [accountId])).rows[0].n);
    expect(await count(admin)).toBeGreaterThan(0);
    expect(await count(manager)).toBe(0);
  });

  it("purges entries older than the 2-year retention and refuses shorter retention", async () => {
    const { accountId } = await createAccount();
    await asSystem(async (db) => {
      await db.query("select set_config('pms.audit_purge', 'on', true)"); // test-only backdating below
      await db.query("alter table public.audit_log disable trigger audit_log_append_only");
      await db.query("update public.audit_log set occurred_at = now() - interval '2 years 1 day' where account_id = $1", [accountId]);
      await db.query("alter table public.audit_log enable trigger audit_log_append_only");
    });
    await expect(query("select private.purge_audit_log(interval '1 year')")).rejects.toThrow(/at least 2 years/);
    const [{ purged }] = await query<{ purged: string }>("select private.purge_audit_log() as purged");
    expect(Number(purged)).toBeGreaterThan(0);
    expect(await query("select 1 from public.audit_log where account_id = $1", [accountId])).toHaveLength(0);
    // The guard is back on afterwards.
    await expect(query("delete from public.audit_log")).rejects.toThrow(/append-only/);
  });
});
