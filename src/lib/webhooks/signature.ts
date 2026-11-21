/**
 * X-04 webhook signatures.
 *
 * Header:  X-PMS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Receivers recompute the HMAC over the raw request body and reject timestamps outside a
 * tolerance window (default 5 minutes) to stop replays. During secret rotation several v1
 * values may be present; any match is accepted.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-pms-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signatureHeader(secret: string, body: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${computeSignature(secret, t, body)}`;
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: "malformed" | "timestamp" | "mismatch" };

export function verifySignature(
  header: string | null | undefined,
  secret: string,
  body: string,
  opts: { now?: Date; toleranceSeconds?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return { ok: false, reason: "malformed" };

  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp" };

  const expected = Buffer.from(computeSignature(secret, timestamp, body), "hex");
  const match = candidates.some((c) => {
    const given = Buffer.from(c, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true, timestamp } : { ok: false, reason: "mismatch" };
}
