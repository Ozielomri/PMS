import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/auth/redirect";

describe("safeNextPath", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeNextPath("/settings/members?x=1#top")).toBe("/settings/members?x=1#top");
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
  });

  it.each(["https://evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)", "evil", "/\tevil", "/%0d%0aSet-Cookie"])(
    "rejects %s",
    (input) => {
      const out = safeNextPath(input);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(out).not.toContain("evil.com");
    },
  );

  it("uses the fallback for empty input", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("", "/onboarding")).toBe("/onboarding");
  });
});
