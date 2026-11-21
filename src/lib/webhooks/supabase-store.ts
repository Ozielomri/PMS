import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimedEvent, EventQueueStore } from "@/lib/events/bus";
import type { ClaimedDelivery, DeliveryStore } from "@/lib/webhooks/dispatcher";

interface ClaimRow {
  delivery_id: string;
  account_id: string;
  attempt_number: number;
  endpoint_id: string;
  url: string;
  secret_ciphertext: string;
  event: ClaimedDelivery["event"];
}

/** DeliveryStore backed by the service-role RPCs in migration 000400. */
export function supabaseDeliveryStore(client: SupabaseClient): DeliveryStore {
  return {
    async claim(limit, leaseSeconds) {
      const { data, error } = await client.rpc("claim_webhook_deliveries", { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw new Error(`claim_webhook_deliveries: ${error.message}`);
      return ((data ?? []) as ClaimRow[]).map((r) => ({
        deliveryId: r.delivery_id,
        accountId: r.account_id,
        attemptNumber: r.attempt_number,
        endpointId: r.endpoint_id,
        url: r.url,
        secretCiphertext: r.secret_ciphertext,
        event: r.event,
      }));
    },
    async record(result) {
      const { data, error } = await client.rpc("record_webhook_attempt", {
        p_delivery_id: result.deliveryId,
        p_success: result.success,
        p_status_code: result.statusCode,
        p_error: result.error,
        p_duration_ms: result.durationMs,
        p_response_body: result.responseBody,
        p_retry_at: result.retryAt?.toISOString() ?? null,
      });
      if (error) throw new Error(`record_webhook_attempt: ${error.message}`);
      return String(data);
    },
  };
}

/** EventQueueStore backed by the service-role RPCs in migration 000200. */
export function supabaseEventQueueStore(client: SupabaseClient): EventQueueStore {
  return {
    async claim(consumer, limit, leaseSeconds): Promise<ClaimedEvent[]> {
      const { data, error } = await client.rpc("claim_events", { p_consumer: consumer, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw new Error(`claim_events: ${error.message}`);
      return ((data ?? []) as { queue_id: number; attempts: number; event: unknown }[]).map((r) => ({ queueId: r.queue_id, attempts: r.attempts, event: r.event }));
    },
    async complete(queueId, success, errorMessage, retryAt) {
      const { error } = await client.rpc("complete_event", {
        p_queue_id: queueId,
        p_success: success,
        p_error: errorMessage,
        p_retry_at: retryAt?.toISOString() ?? null,
      });
      if (error) throw new Error(`complete_event: ${error.message}`);
    },
  };
}
