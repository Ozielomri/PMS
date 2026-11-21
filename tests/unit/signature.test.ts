import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeSignature, signatureHeader, verifySignature } from "@/lib/webhooks/signature";

const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "reservation.created" });
const now = new Date("2026-11-21T12:00:00Z");

describe("webhook signatures (X-04)", () => {
  it("is HMAC-SHA256 over '<timestamp>.<body>'", () => {
    const t = Math.floor(now.getTime() / 1000);
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(computeSignature(secret, t, body)).toBe(expected);
    expect(signatureHeader(secret, body, now)).toBe(`t=${t},v1=${expected}`);
  });

  it("verifies a valid header", () => {
    expect(verifySignature(signatureHeader(secret, body, now), secret, body, { now })).toEqual({ ok: true, timestamp: now.getTime() / 1000 });
  });

  it("rejects a modified body, the wrong secret and garbage", () => {
    const header = signatureHeader(secret, body, now);
    expect(verifySignature(header, secret, body + " ", { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(header, "whsec_other", body, { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature("nonsense", secret, body, { now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature(null, secret, body, { now })).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects replays outside the tolerance window", () => {
    const header = signatureHeader(secret, body, now);
    const later = new Date(now.getTime() + 301_000);
    expect(verifySignature(header, secret, body, { now: later })).toEqual({ ok: false, reason: "timestamp" });
  });

  it("accepts any of several v1 signatures (secret rotation)", () => {
    const t = Math.floor(now.getTime() / 1000);
    const header = `t=${t},v1=${computeSignature("whsec_old", t, body)},v1=${computeSignature(secret, t, body)}`;
    expect(verifySignature(header, secret, body, { now }).ok).toBe(true);
  });
});
