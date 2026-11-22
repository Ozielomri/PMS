/**
 * CAL-10: fetches an external iCal feed with SSRF protection (public https hosts only, every
 * resolved address and every redirect target checked), a timeout covering the whole download,
 * a size limit enforced while streaming, and conditional GET (ETag / Last-Modified).
 * Residual risk, as for webhooks: DNS rebinding between our lookup and fetch's own lookup.
 */
import { assertPublicDestination, type Lookup } from "@/lib/webhooks/url-guard";

export class FeedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export type FeedFetchResult = { status: "ok"; body: string; etag: string | null; lastModified: string | null } | { status: "not_modified" };

export interface FetchFeedOptions {
  etag?: string | null;
  lastModified?: string | null;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  lookup?: Lookup;
  allowPrivateNetworks?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export const FEED_TIMEOUT_MS = 15_000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "PMS-iCal/1.0 (+calendar sync)";

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new FeedFetchError(`The feed is larger than ${Math.round(maxBytes / 1024)} KB`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FeedFetchError(`The feed is larger than ${Math.round(maxBytes / 1024)} KB`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export async function fetchFeed(rawUrl: string, opts: FetchFeedOptions = {}): Promise<FeedFetchResult> {
  const timeoutMs = opts.timeoutMs ?? FEED_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? FEED_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);

  let url = rawUrl;
  try {
    for (let hop = 0; ; hop++) {
      try {
        await assertPublicDestination(url, { allowPrivateNetworks: opts.allowPrivateNetworks, lookup: opts.lookup, label: "iCal feed URLs" });
      } catch (err) {
        throw new FeedFetchError((err as Error).message);
      }
      const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1", "user-agent": USER_AGENT };
      if (opts.etag) headers["if-none-match"] = opts.etag;
      if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

      const response = await doFetch(url, { method: "GET", headers, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new FeedFetchError(`HTTP ${response.status} without a Location header`);
        if (hop >= maxRedirects) throw new FeedFetchError("The feed URL has too many redirects");
        url = new URL(location, url).toString();
        continue;
      }
      if (response.status === 304) return { status: "not_modified" };
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new FeedFetchError(`The feed answered HTTP ${response.status}`);
      }
      const body = await readCapped(response, maxBytes);
      return { status: "ok", body, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") };
    }
  } catch (err) {
    if (err instanceof FeedFetchError) throw err;
    const e = err as Error;
    if (signal.aborted || e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new FeedFetchError(`The feed timed out after ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new FeedFetchError(`Could not reach the feed: ${e?.message || "network error"}`);
  }
}
