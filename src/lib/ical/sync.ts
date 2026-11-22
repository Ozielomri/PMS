/**
 * CAL-10 pipeline for one feed: decrypt the URL, fetch (guarded), parse, normalise into the
 * listing's nights, then let the database diff and apply it (public.apply_ical_feed_sync). Any
 * failure is recorded on the feed (public.record_ical_feed_failure) and keeps existing blocks.
 * Used by the worker (service role) and by "Sync now" (the signed-in user's client).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { localToday } from "@/lib/calendar/dates";
import { decryptSecret } from "@/lib/crypto/secrets";

import { fetchFeed, type FetchFeedOptions } from "./fetch";
import { normalizeEvents } from "./normalize";
import { parseIcs } from "./parse";

export interface FeedToSync {
  feedId: string;
  urlCiphertext: string;
  etag: string | null;
  lastModified: string | null;
  /** The listing's timezone (the parent's for a sub-unit). */
  timeZone: string;
}

export interface SyncResult {
  status: "ok" | "conflict";
  events: number;
  placed: number;
  moved: number;
  released: number;
  restored: number;
  unchanged: boolean;
  conflicts: number;
}

export type SyncOutcome = { ok: true; result: SyncResult } | { ok: false; error: string };

export interface SyncOptions {
  encryptionKey: Buffer;
  fetch?: Omit<FetchFeedOptions, "etag" | "lastModified">;
  now?: Date;
}

type RpcClient = Pick<SupabaseClient, "rpc">;

/** Database errors the user can act on, in plain words. */
export function syncErrorMessage(message: string): string {
  if (/listing_not_bookable/.test(message)) return "The listing is archived or cannot take blocks.";
  if (/invalid_events/.test(message)) return "The feed contains events the calendar cannot store.";
  if (/forbidden/.test(message)) return "You do not have permission to sync this feed.";
  return "Could not save the imported events. Try again.";
}

export async function syncFeed(client: RpcClient, feed: FeedToSync, opts: SyncOptions): Promise<SyncOutcome> {
  const fail = async (error: string): Promise<SyncOutcome> => {
    const { error: rpcError } = await client.rpc("record_ical_feed_failure", { p_feed_id: feed.feedId, p_error: error });
    if (rpcError && /ical_feed_removed|ical_feed_not_found/.test(rpcError.message)) return { ok: false, error: "The feed was removed." };
    return { ok: false, error };
  };

  let url: string;
  try {
    url = decryptSecret(feed.urlCiphertext, opts.encryptionKey, feed.feedId);
  } catch {
    return fail("Could not decrypt the feed URL (encryption key changed?). Remove the feed and add it again.");
  }

  let events: { uid: string; check_in: string; check_out: string }[] | null = null;
  let meta: Record<string, unknown> = {};
  try {
    const fetched = await fetchFeed(url, { ...opts.fetch, etag: feed.etag, lastModified: feed.lastModified });
    if (fetched.status === "ok") {
      const { events: parsed } = parseIcs(fetched.body);
      const { blocks, skipped } = normalizeEvents(parsed, { timeZone: feed.timeZone, today: localToday(feed.timeZone, opts.now) });
      events = blocks;
      meta = { etag: fetched.etag, last_modified: fetched.lastModified, skipped };
    }
  } catch (err) {
    return fail((err as Error).message || "Import failed");
  }

  const { data, error } = await client.rpc("apply_ical_feed_sync", { p_feed_id: feed.feedId, p_events: events, p_meta: meta });
  if (error) {
    if (/ical_feed_removed|ical_feed_not_found/.test(error.message)) return { ok: false, error: "The feed was removed." };
    return fail(syncErrorMessage(error.message));
  }
  return { ok: true, result: data as SyncResult };
}
