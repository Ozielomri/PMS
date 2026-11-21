import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, generateToken, parseKey } from "@/lib/crypto/secrets";

const key = randomBytes(32);

describe("field-level encryption (X-15)", () => {
  it("round-trips and never contains the plaintext", () => {
    const ct = encryptSecret("whsec_supersecret", key, "endpoint-1");
    expect(ct).toMatch(/^v1\./);
    expect(ct).not.toContain("supersecret");
    expect(decryptSecret(ct, key, "endpoint-1")).toBe("whsec_supersecret");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("fails with the wrong key, the wrong context or tampered ciphertext", () => {
    const ct = encryptSecret("door code 4711", key, "listing-9");
    expect(() => decryptSecret(ct, randomBytes(32), "listing-9")).toThrow();
    expect(() => decryptSecret(ct, key, "listing-10")).toThrow();
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "listing-9")).toThrow();
    expect(() => decryptSecret("v2.a.b.c", key)).toThrow(/Unsupported/);
  });

  it("validates key length", () => {
    expect(parseKey(key.toString("base64"))).toHaveLength(32);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("generates prefixed random tokens", () => {
    const t = generateToken("whsec_");
    expect(t).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateToken("whsec_")).not.toBe(t);
  });
});
