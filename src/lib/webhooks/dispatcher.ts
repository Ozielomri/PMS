/**
 * X-04 outbound webhook dispatcher. Runs from /api/internal/webhooks/dispatch on a schedule.
 *
 * 1. Claim due deliveries (store; FOR UPDATE SKIP LOCKED with a lease, so runs can overlap).
 * 2. For each: SSRF check, decrypt the endpoint secret, sign, POST with a timeout.
 * 3. Record the attempt; on failure schedule a retry with exponential backoff. The database
 *    closes a delivery as failed once a retry would fall outside its 24-hour window.
 *
 * Delivery is at-least-once: receivers should dedupe on the X-PMS-Event-Id header.
 */
import { decryptSecret } from "@/lib/crypto/secrets";
import { nextRetryAt, WEBHOOK_BACKOFF } from "@/lib/retry/backoff";
import { signatureHeader } from "@/lib/webhooks/signature";
import { assertPublicDestination, type Lookup } from "@/lib/webhooks/url-guard";

export interface ClaimedDelivery {
  deliveryId: string;
  accountId: string;
  attemptNumber: number;
  endpointId: string;
  url: string;
  secretCiphertext: string;
  event: { id: string; type: string } & Record<string, unknown>;
}

export interface AttemptResult {
  deliveryId: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  responseBody: string | null;
  /** When to try again; null = do not retry. */
  retryAt: Date | null;
}

export interface DeliveryStore {
  claim(limit: number, leaseSeconds: number): Promise<ClaimedDelivery[]>;
  /** Returns the delivery's new status ('succeeded' | 'pending' | 'failed'). */
  record(result: AttemptResult): Promise<string>;
}

export interface DispatchOptions {
  store: DeliveryStore;
  encryptionKey: Buffer;
  limit?: number;
  leaseSeconds?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** Local development and tests only. */
  allowPrivateNetworks?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => Date;
  random?: () => number;
}

export interface DispatchSummary {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
}

export const USER_AGENT = "PMS-Webhooks/1.0";
const MAX_RESPONSE_BYTES = 2048;

/** Status codes that mean "stop sending this": the receiver is gone or rejects it for good. */
const PERMANENT_FAILURE_STATUSES = new Set([410]);

export async function dispatchWebhooks(opts: DispatchOptions): Promise<DispatchSummary> {
  const claimed = await opts.store.claim(opts.limit ?? 50, opts.leaseSeconds ?? 60);
  const summary: DispatchSummary = { claimed: claimed.length, succeeded: 0, retrying: 0, failed: 0 };

  await runPool(claimed, opts.concurrency ?? 8, async (delivery) => {
    const result = await deliverOnce(delivery, opts);
    const status = await opts.store.record(result);
    if (status === "succeeded") summary.succeeded++;
    else if (status === "pending") summary.retrying++;
    else summary.failed++;
  });
  return summary;
}

export async function deliverOnce(delivery: ClaimedDelivery, opts: DispatchOptions): Promise<AttemptResult> {
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const fail = (error: string, statusCode: number | null, responseBody: string | null, retry: boolean): AttemptResult => ({
    deliveryId: delivery.deliveryId,
    success: false,
    statusCode,
    error,
    durationMs: Date.now() - started,
    responseBody,
    retryAt: retry
      ? nextRetryAt({ attempt: delivery.attemptNumber, now: now(), random: opts.random, ...WEBHOOK_BACKOFF })
      : null,
  });

  let secret: string;
  try {
    secret = decryptSecret(delivery.secretCiphertext, opts.encryptionKey, delivery.endpointId);
  } catch {
    return fail("could not decrypt endpoint secret", null, null, false);
  }

  try {
    await assertPublicDestination(delivery.url, { allowPrivateNetworks: opts.allowPrivateNetworks, lookup: opts.lookup });
  } catch (err) {
    return fail(`blocked destination: ${(err as Error).message}`, null, null, false);
  }

  const body = JSON.stringify(delivery.event);
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-pms-event-id": delivery.event.id,
    "x-pms-event-type": delivery.event.type,
    "x-pms-delivery-id": delivery.deliveryId,
    "x-pms-delivery-attempt": String(delivery.attemptNumber),
    "x-pms-signature": signatureHeader(secret, body, now()),
  };

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(delivery.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const e = err as Error;
    const message = e.name === "TimeoutError" ? "timed out" : e.message || "network error";
    return fail(message, null, null, true);
  }

  const responseBody = await readCapped(response);
  if (response.status >= 200 && response.status < 300) {
    return {
      deliveryId: delivery.deliveryId,
      success: true,
      statusCode: response.status,
      error: null,
      durationMs: Date.now() - started,
      responseBody,
      retryAt: null,
    };
  }
  return fail(`HTTP ${response.status}`, response.status, responseBody, !PERMANENT_FAILURE_STATUSES.has(response.status));
}

async function readCapped(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
  } catch {
    return null;
  }
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
