import { timingSafeEqual } from "node:crypto";

/**
 * Internal worker endpoints are called by a scheduler (Vercel Cron, Supabase pg_cron + pg_net,
 * or any external cron) with `Authorization: Bearer $CRON_SECRET`.
 */
export function isAuthorizedCronRequest(authorization: string | null, secret: string): boolean {
  if (!authorization || !secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
