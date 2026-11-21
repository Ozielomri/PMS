/**
 * X-04 internal event bus. Each consumer (automations, notifications, ...) is a row in
 * public.event_consumers plus a handler in ./consumers.ts. The database fans every event out to
 * matching consumers in the same transaction it was emitted in; this worker claims and runs them.
 *
 * At-least-once: a handler may see an event twice (crash after success, lease expiry), so
 * handlers must be idempotent — e.g. AUT-07 dedupes on (rule, reservation, trigger occurrence).
 */
import { nextRetryAt } from "@/lib/retry/backoff";
import { domainEventSchema, type DomainEvent } from "@/lib/events/types";

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface ClaimedEvent {
  queueId: number;
  attempts: number;
  event: unknown;
}

export interface EventQueueStore {
  claim(consumer: string, limit: number, leaseSeconds: number): Promise<ClaimedEvent[]>;
  complete(queueId: number, success: boolean, error: string | null, retryAt: Date | null): Promise<void>;
}

export interface ProcessOptions {
  consumer: string;
  handler: EventHandler;
  store: EventQueueStore;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  now?: () => Date;
  random?: () => number;
}

export interface ProcessSummary {
  consumer: string;
  claimed: number;
  done: number;
  retrying: number;
  failed: number;
}

export const BUS_BACKOFF = { baseDelayMs: 10_000, maxDelayMs: 30 * 60_000, jitter: 0.2 } as const;
export const BUS_MAX_ATTEMPTS = 10;

export async function processConsumer(opts: ProcessOptions): Promise<ProcessSummary> {
  const now = opts.now ?? (() => new Date());
  const items = await opts.store.claim(opts.consumer, opts.limit ?? 100, opts.leaseSeconds ?? 60);
  const summary: ProcessSummary = { consumer: opts.consumer, claimed: items.length, done: 0, retrying: 0, failed: 0 };

  // Sequential, in event order: consumers such as automations care about ordering.
  for (const item of items) {
    const parsed = domainEventSchema.safeParse(item.event);
    if (!parsed.success) {
      await opts.store.complete(item.queueId, false, `invalid event envelope: ${parsed.error.message}`, null);
      summary.failed++;
      continue;
    }
    try {
      await opts.handler(parsed.data);
      await opts.store.complete(item.queueId, true, null, null);
      summary.done++;
    } catch (err) {
      const retryAt = nextRetryAt({
        attempt: item.attempts,
        now: now(),
        maxAttempts: opts.maxAttempts ?? BUS_MAX_ATTEMPTS,
        random: opts.random,
        ...BUS_BACKOFF,
      });
      await opts.store.complete(item.queueId, false, (err as Error)?.message ?? String(err), retryAt);
      if (retryAt) summary.retrying++;
      else summary.failed++;
    }
  }
  return summary;
}
