/**
 * CAL-10 worker: claims due feeds in batches (with a lease) and syncs a few at a time until the
 * time budget is used. Each feed's outcome is stored on the feed itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { syncFeed, type SyncOptions } from "./sync";

interface ClaimedFeed {
  feed_id: string;
  url_ciphertext: string;
  etag: string | null;
  last_modified: string | null;
  timezone: string;
}

export interface WorkerSummary {
  claimed: number;
  synced: number;
  failed: number;
}

export async function syncDueFeeds(
  client: Pick<SupabaseClient, "rpc">,
  opts: SyncOptions & { budgetMs?: number; batchSize?: number; concurrency?: number },
): Promise<WorkerSummary> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const batchSize = opts.batchSize ?? 8;
  const concurrency = opts.concurrency ?? 4;
  const summary: WorkerSummary = { claimed: 0, synced: 0, failed: 0 };

  while (Date.now() - started < budget) {
    // The lease outlasts a batch (4 parallel × 15 s fetch timeout, plus the database work).
    const { data, error } = await client.rpc("claim_ical_feeds", { p_limit: batchSize, p_lease_seconds: 180 });
    if (error) throw new Error(`claim_ical_feeds: ${error.message}`);
    const feeds = (data ?? []) as ClaimedFeed[];
    if (feeds.length === 0) break;
    summary.claimed += feeds.length;

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, feeds.length) }, async () => {
        while (next < feeds.length) {
          const f = feeds[next++];
          const outcome = await syncFeed(
            client,
            { feedId: f.feed_id, urlCiphertext: f.url_ciphertext, etag: f.etag, lastModified: f.last_modified, timeZone: f.timezone },
            opts,
          );
          if (outcome.ok) summary.synced++;
          else summary.failed++;
        }
      }),
    );
    if (feeds.length < batchSize) break;
  }
  return summary;
}
