import type { EventQueueStore } from "@/lib/events/bus";
import type { ClaimedDelivery, DeliveryStore } from "@/lib/webhooks/dispatcher";

import { as } from "./helpers";

/**
 * The same service-role RPCs the Supabase-backed stores call (src/lib/webhooks/supabase-store.ts),
 * invoked over a direct connection with role service_role.
 */
const service = { role: "service_role" as const, headers: { "x-pms-actor-type": "system", "x-pms-actor-id": "test-worker" } };

export const pgDeliveryStore: DeliveryStore = {
  async claim(limit, leaseSeconds) {
    return as(service, async (db) => {
      const { rows } = await db.query("select * from public.claim_webhook_deliveries($1, $2)", [limit, leaseSeconds]);
      return rows.map(
        (r): ClaimedDelivery => ({
          deliveryId: r.delivery_id,
          accountId: r.account_id,
          attemptNumber: r.attempt_number,
          endpointId: r.endpoint_id,
          url: r.url,
          secretCiphertext: r.secret_ciphertext,
          event: r.event,
        }),
      );
    });
  },
  async record(result) {
    return as(service, async (db) => {
      const { rows } = await db.query("select public.record_webhook_attempt($1, $2, $3, $4, $5, $6, $7) as status", [
        result.deliveryId,
        result.success,
        result.statusCode,
        result.error,
        result.durationMs,
        result.responseBody,
        result.retryAt,
      ]);
      return rows[0].status as string;
    });
  },
};

export const pgEventQueueStore: EventQueueStore = {
  async claim(consumer, limit, leaseSeconds) {
    return as(service, async (db) => {
      const { rows } = await db.query("select * from public.claim_events($1, $2, $3)", [consumer, limit, leaseSeconds]);
      return rows.map((r) => ({ queueId: Number(r.queue_id), attempts: r.attempts, event: r.event }));
    });
  },
  async complete(queueId, success, error, retryAt) {
    await as(service, (db) => db.query("select public.complete_event($1, $2, $3, $4)", [queueId, success, error, retryAt]));
  },
};
