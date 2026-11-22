/**
 * SSRF protection for outbound webhooks (OWASP A10). Endpoints must be public HTTPS URLs;
 * the hostname is checked when the endpoint is saved and again, after DNS resolution, before
 * every send. Residual risk: DNS rebinding between our lookup and fetch's own lookup.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: treat as unsafe
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export interface UrlGuardOptions {
  /** Allow http:// and private/loopback hosts. Only for local development and tests. */
  allowPrivateNetworks?: boolean;
  /** Subject of the error messages, e.g. "iCal feed URLs". Default "Webhook URLs". */
  label?: string;
}

/** Syntax-level check used when an endpoint (webhook, iCal feed) is saved. */
export function validatePublicUrl(raw: string, opts: UrlGuardOptions = {}): UrlCheck {
  const label = opts.label ?? "Webhook URLs";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (raw.length > 2000) return { ok: false, reason: "URL is too long" };

  if (opts.allowPrivateNetworks) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Use an http(s) URL" };
    return { ok: true, url };
  }

  if (url.protocol !== "https:") return { ok: false, reason: `${label} must use https` };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || (!host.includes(".") && !isIP(host))) {
    return { ok: false, reason: `${label} must point to a public host` };
  }
  if (isIP(host) && isPrivateAddress(host)) {
    return { ok: false, reason: `${label} must not point to a private network address` };
  }
  return { ok: true, url };
}

/** The webhook endpoint check (kept for its callers). */
export const validateWebhookUrl = validatePublicUrl;

export type Lookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Send-time check: every resolved address must be public. */
export async function assertPublicDestination(
  raw: string,
  opts: UrlGuardOptions & { lookup?: Lookup } = {},
): Promise<URL> {
  const check = validatePublicUrl(raw, opts);
  if (!check.ok) throw new Error(check.reason);
  if (opts.allowPrivateNetworks) return check.url;

  const host = check.url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${host} resolves to a private address`);
    }
  }
  return check.url;
}
