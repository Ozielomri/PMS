import { describe, expect, it } from "vitest";

import { assertPublicDestination, isPrivateAddress, validateWebhookUrl } from "@/lib/webhooks/url-guard";

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
  it("treats non-IPs as unsafe", () => expect(isPrivateAddress("example.com")).toBe(true));
});

describe("validateWebhookUrl", () => {
  it("accepts public https URLs", () => {
    expect(validateWebhookUrl("https://hooks.example.com/pms").ok).toBe(true);
  });

  it.each([
    ["http://hooks.example.com", /https/],
    ["https://localhost/x", /public host/],
    ["https://printer.local/x", /public host/],
    ["https://intranet/x", /public host/],
    ["https://169.254.169.254/latest/meta-data", /private/],
    ["https://[::1]/x", /private/],
    ["https://user:pass@example.com/x", /credentials/],
    ["not a url", /valid URL/],
    ["ftp://example.com", /https/],
  ])("rejects %s", (url, reason) => {
    const result = validateWebhookUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("allows http and private hosts only in development mode", () => {
    expect(validateWebhookUrl("http://127.0.0.1:4000/x", { allowPrivateNetworks: true }).ok).toBe(true);
    expect(validateWebhookUrl("ftp://127.0.0.1", { allowPrivateNetworks: true }).ok).toBe(false);
  });
});

describe("assertPublicDestination", () => {
  it("rejects hosts that resolve to private addresses (DNS check at send time)", async () => {
    const lookup = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
    await expect(assertPublicDestination("https://sneaky.example.com/x", { lookup })).rejects.toThrow(/private address/);
  });

  it("accepts hosts that resolve only to public addresses", async () => {
    const lookup = async () => [{ address: "93.184.216.34" }];
    await expect(assertPublicDestination("https://ok.example.com/x", { lookup })).resolves.toBeInstanceOf(URL);
  });

  it("fails when the host does not resolve", async () => {
    await expect(assertPublicDestination("https://nx.example.com/x", { lookup: async () => [] })).rejects.toThrow(/resolve/);
  });
});
