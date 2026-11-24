import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, inject } from "vitest";

import type { Role } from "@/lib/auth/permissions";

export const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 10 });

afterAll(async () => {
  await pool.end();
});

export type Db = pg.PoolClient;

export interface RequestContext {
  /** Signed-in user (role 'authenticated'); omit for anon/service_role. */
  userId?: string;
  email?: string;
  role?: "authenticated" | "anon" | "service_role";
  aal?: "aal1" | "aal2";
  headers?: Record<string, string>;
  /**
   * X-02 admin MFA gate. Tests run with it on (the stricter setting) unless they say otherwise;
   * false uses the platform switch in private.app_settings (off during the trial).
   */
  requireMfa?: boolean;
}

/**
 * Runs fn inside a transaction that looks like a PostgREST request from Supabase: the given
 * database role, JWT claims in `request.jwt.claims` and HTTP headers in `request.headers`.
 * Commits on success so tests can observe effects from other connections.
 */
export async function as<T>(ctx: RequestContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const role = ctx.role ?? (ctx.userId ? "authenticated" : "anon");
  const claims: Record<string, unknown> = { role };
  if (ctx.userId) {
    claims.sub = ctx.userId;
    claims.aal = ctx.aal ?? "aal1";
    if (ctx.email) claims.email = ctx.email;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true), set_config('pms.mfa_required', $3, true)",
      [JSON.stringify(claims), JSON.stringify(ctx.headers ?? {}), ctx.requireMfa === false ? "" : "on"],
    );
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs as the postgres superuser (a direct database connection: actor = system). */
export async function asSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

export async function createUser(opts: { email?: string; fullName?: string } = {}): Promise<{ id: string; email: string }> {
  const email = opts.email ?? `user-${randomUUID().slice(0, 8)}@example.test`;
  const [row] = await query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(opts.fullName ? { full_name: opts.fullName } : {})],
  );
  return { id: row.id, email };
}

export interface TestAccount {
  accountId: string;
  admin: { id: string; email: string };
}

/** New account created through the public RPC by a TOTP-verified admin. */
export async function createAccount(name = "Test Rentals"): Promise<TestAccount> {
  const admin = await createUser({ fullName: "Admin User" });
  const accountId = await as({ userId: admin.id, email: admin.email, aal: "aal2" }, async (db) => {
    const { rows } = await db.query<{ id: string }>("select public.create_account($1) as id", [name]);
    return rows[0].id;
  });
  return { accountId, admin };
}

/** Adds an active member directly (bypassing invitations) and returns the user. */
export async function addMember(accountId: string, role: Role, extra: { status?: string } = {}) {
  const user = await createUser();
  const [m] = await query<{ id: string }>(
    "insert into public.memberships (account_id, user_id, role, status) values ($1, $2, $3, $4) returning id",
    [accountId, user.id, role, extra.status ?? "active"],
  );
  return { ...user, membershipId: m.id };
}

/** Shorthand: as the given user, with aal2 by default so admins hold their permissions. */
export function asUser<T>(user: { id: string; email?: string }, fn: (db: Db) => Promise<T>, opts: Partial<RequestContext> = {}) {
  return as({ userId: user.id, email: user.email, aal: "aal2", ...opts }, fn);
}
