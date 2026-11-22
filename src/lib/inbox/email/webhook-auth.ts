import { timingSafeEqual } from "node:crypto";

import { verifySignature } from "@/lib/webhooks/signature";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Inbound email and delivery webhooks are authorized with INBOX_WEBHOOK_SECRET, either as
 *   * `Authorization: Bearer <secret>`,
 *   * HTTP Basic auth whose password is the secret (Postmark: https://user:<secret>@host/path), or
 *   * `X-PMS-Signature: t=…,v1=…` = HMAC-SHA256 of the raw body (same scheme as our outbound webhooks).
 */
export function isAuthorizedInboxWebhook(input: { authorization: string | null; signature: string | null; body: string; secret: string; now?: Date }): boolean {
  const { authorization, signature, body, secret } = input;
  if (!secret) return false;
  if (authorization?.startsWith("Bearer ") && same(authorization.slice(7), secret)) return true;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (decoded.includes(":") && same(password, secret)) return true;
  }
  if (signature) return verifySignature(signature, secret, body, { now: input.now }).ok;
  return false;
}
