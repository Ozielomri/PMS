import { describe, expect, it } from "vitest";

import { mfaRequirement, normaliseTotpCode } from "@/lib/auth/mfa";

describe("mfaRequirement (X-02)", () => {
  it.each([
    // isAdmin, current, next, expected
    [true, "aal1", "aal1", "enroll"],
    [true, "aal1", "aal2", "verify"],
    [true, "aal2", "aal2", "ok"],
    [false, "aal1", "aal1", "ok"],
    [false, "aal1", "aal2", "verify"],
    [false, "aal2", "aal2", "ok"],
    [true, null, null, "enroll"],
    [false, undefined, undefined, "ok"],
  ] as const)("admin=%s current=%s next=%s → %s", (isAdmin, currentLevel, nextLevel, expected) => {
    expect(mfaRequirement({ isAdmin, currentLevel, nextLevel })).toBe(expected);
  });
});

describe("mfaRequirement with the switch off", () => {
  it("never asks for a code", () => {
    expect(mfaRequirement({ required: false, isAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe("ok");
    expect(mfaRequirement({ required: false, isAdmin: true, currentLevel: "aal1", nextLevel: "aal2" })).toBe("ok");
    expect(mfaRequirement({ required: true, isAdmin: true, currentLevel: "aal1", nextLevel: "aal2" })).toBe("verify");
  });
});

describe("normaliseTotpCode", () => {
  it("accepts 6 digits with spaces or dashes", () => {
    expect(normaliseTotpCode("123456")).toBe("123456");
    expect(normaliseTotpCode("123 456")).toBe("123456");
    expect(normaliseTotpCode(" 123-456 ")).toBe("123456");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "12345", "1234567", "12a456"]) expect(normaliseTotpCode(bad)).toBeNull();
  });
});
