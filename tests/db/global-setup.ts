import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import type { TestProject } from "vitest/node";

const ROOT = join(import.meta.dirname, "..", "..");
// Override when several checkouts test against one server at once (e.g. parallel worktrees).
const TEST_DB = process.env.TEST_DB_NAME ?? "pms_test";
if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DB)) throw new Error("TEST_DB_NAME must be a plain lowercase identifier");

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export function migrationFiles(): string[] {
  const dir = join(ROOT, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Creates a fresh `pms_test` database, applies the Supabase shim (only on plain Postgres) and
 * every migration in order — the same files `supabase db push` applies in production.
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${TEST_DB}`;
  const databaseUrl = url.toString();

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query("select 1 from pg_namespace where nspname = 'auth'");
    if (rows.length === 0) {
      await db.query(readFileSync(join(ROOT, "tests", "db", "supabase-shim.sql"), "utf8"));
    }
    for (const file of migrationFiles()) {
      try {
        await db.query(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await db.end();
  }

  project.provide("databaseUrl", databaseUrl);
}
