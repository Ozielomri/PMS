/**
 * Engineering rule: every table has RLS scoped to the account. These tests check the rule
 * structurally (catalog) and behaviourally (one tenant cannot see another's rows).
 */
import { describe, expect, it } from "vitest";

import { as, addMember, asUser, createAccount, query } from "./helpers";

const ACCOUNT_SCOPED_TABLES = [
  "accounts",
  "memberships",
  "membership_listing_scopes",
  "invitations",
  "audit_log",
  "domain_events",
  "webhook_endpoints",
  "webhook_deliveries",
  "webhook_delivery_attempts",
  "listings",
  // Step 3 — properties
  "listing_rooms",
  "listing_amenities",
  "listing_descriptions",
  "listing_photos",
  "listing_channel_links",
  "custom_fields",
  "listing_custom_values",
  // Step 2 — calendar
  "calendar_days",
  "calendar_holds",
  "calendar_changes",
  "calendar_api_tokens",
];

describe("row level security", () => {
  it("is enabled on every table in the public schema", async () => {
    const rows = await query<{ table: string }>(
      `select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("isolates accounts from each other", async () => {
    const a = await createAccount("Tenant A");
    const b = await createAccount("Tenant B");
    // Generate some rows in B: an invitation, an endpoint (and therefore events and deliveries).
    await asUser(b.admin, async (db) => {
      await db.query("select * from public.create_invitation($1, 'x@example.test', 'cleaner')", [b.accountId]);
      await db.query(
        "insert into public.webhook_endpoints (account_id, url, secret_ciphertext, secret_last4) values ($1, 'https://example.com/h', 'v1.x.y.z', 'abcd')",
        [b.accountId],
      );
      await db.query("update public.accounts set name = 'Tenant B2' where id = $1", [b.accountId]);
    });

    const seen = await asUser(a.admin, async (db) => {
      const out: Record<string, number> = {};
      for (const table of ACCOUNT_SCOPED_TABLES) {
        const column = table === "accounts" ? "id" : "account_id";
        const { rows } = await db.query(`select count(*)::int as n from public.${table} where ${column} = $1`, [b.accountId]);
        out[table] = rows[0].n;
      }
      return out;
    });
    expect(seen).toEqual(Object.fromEntries(ACCOUNT_SCOPED_TABLES.map((t) => [t, 0])));
  });

  it("gives anonymous requests nothing", async () => {
    await createAccount();
    for (const table of [...ACCOUNT_SCOPED_TABLES, "profiles", "role_permissions", "event_queue", "event_consumers", "amenities"]) {
      const result = await as({ role: "anon" }, (db) => db.query(`select count(*)::int as n from public.${table}`)).then(
        (r) => r.rows[0].n as number,
        (e: Error) => e.message,
      );
      expect([table, result]).toSatisfy(([, r]: [string, number | string]) => r === 0 || /permission denied/.test(String(r)));
    }
  });

  it("hides profiles of users who share no account", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const visible = await asUser(a.admin, async (db) => (await db.query("select user_id from public.profiles")).rows.map((r) => r.user_id));
    expect(visible).toContain(a.admin.id);
    expect(visible).not.toContain(b.admin.id);
  });

  it("does not let clients write events or audit entries directly", async () => {
    const { accountId, admin } = await createAccount();
    await expect(
      asUser(admin, (db) =>
        db.query(
          "insert into public.domain_events (account_id, type, entity_type, entity_id, actor_type) values ($1, 'reservation.created', 'x', 'y', 'user')",
          [accountId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(admin, (db) =>
        db.query("insert into public.audit_log (account_id, actor_type, entity_type, entity_id, action, diff) values ($1, 'user', 'x', 'y', 'insert', '{}')", [
          accountId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, (db) => db.query("select private.emit_event($1, 'account.updated', 'account', 'x')", [accountId]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("exposes only the RLS helper functions of the private schema to clients", async () => {
    const rows = await query<{ fn: string }>(
      `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and (has_function_privilege('authenticated', p.oid, 'execute')
                                        or has_function_privilege('anon', p.oid, 'execute'))
       order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([
      "can_access_listing",
      "can_edit_listing_photo_path", // storage.objects policies (step 3)
      "can_view_listing_calendar",
      "current_aal",
      "has_permission",
      "is_member",
      "listing_scope_tags",
      "member_role",
      "shares_account_with",
    ]);
  });

  it("reserves worker functions for the service role", async () => {
    const { admin } = await createAccount();
    for (const sql of [
      "select * from public.claim_events('x')",
      "select public.complete_event(1, true)",
      "select * from public.claim_webhook_deliveries()",
      "select public.record_webhook_attempt(gen_random_uuid(), true)",
      "select public.place_hold(gen_random_uuid(), current_date, current_date + 1, 'reservation')",
      "select public.release_hold(gen_random_uuid())",
      "select public.move_hold(gen_random_uuid(), current_date, current_date + 1)",
      "select public.apply_pricing_tool_updates('x', '[]'::jsonb)",
      "select public.extend_calendar_horizon()",
      "select public.expire_calendar_holds()",
    ]) {
      await expect(asUser(admin, (db) => db.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("does not allow hard deletes of memberships", async () => {
    const { accountId, admin } = await createAccount();
    const member = await addMember(accountId, "cleaner");
    await expect(asUser(admin, (db) => db.query("delete from public.memberships where id = $1", [member.membershipId]))).rejects.toThrow(
      /permission denied/,
    );
  });
});
