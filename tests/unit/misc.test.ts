import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/routes";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { actorHeaders, clientIpFromHeaders } from "@/lib/supabase/request-context";
import { supabaseDeliveryStore, supabaseEventQueueStore } from "@/lib/webhooks/supabase-store";

describe("isPublicPath", () => {
  it.each(["/login", "/signup", "/auth/confirm", "/invite/abc", "/api/internal/webhooks/dispatch"])("%s is public", (p) =>
    expect(isPublicPath(p)).toBe(true),
  );
  it.each(["/", "/dashboard", "/settings/members", "/mfa", "/onboarding", "/loginx", "/invite"])("%s needs a session", (p) =>
    expect(isPublicPath(p)).toBe(false),
  );
});

describe("isAuthorizedCronRequest", () => {
  it("accepts only the exact bearer token", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedCronRequest("Bearer s3cre", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
  });
});

describe("request context headers", () => {
  it("takes the first x-forwarded-for hop", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }))).toBe("203.0.113.1");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  it("builds actor headers for service-role clients", () => {
    expect(actorHeaders({ type: "channel", id: "booking_com" })).toEqual({ "x-pms-actor-type": "channel", "x-pms-actor-id": "booking_com" });
    expect(actorHeaders({ type: "system" })).toEqual({ "x-pms-actor-type": "system" });
  });
});

describe("Supabase-backed stores", () => {
  function fakeClient(data: unknown) {
    const calls: { fn: string; args: unknown }[] = [];
    const client = {
      rpc(fn: string, args: unknown) {
        calls.push({ fn, args });
        const result = { data, error: null };
        return Object.assign(Promise.resolve(result), { returns: () => Promise.resolve(result) });
      },
    };
    return { client: client as never, calls };
  }

  it("maps webhook RPCs", async () => {
    const { client, calls } = fakeClient([
      { delivery_id: "d", account_id: "a", attempt_number: 2, endpoint_id: "e", url: "https://x.test", secret_ciphertext: "c", event: { id: "1", type: "t" } },
    ]);
    const store = supabaseDeliveryStore(client);
    expect(await store.claim(10, 30)).toEqual([
      { deliveryId: "d", accountId: "a", attemptNumber: 2, endpointId: "e", url: "https://x.test", secretCiphertext: "c", event: { id: "1", type: "t" } },
    ]);
    await store.record({ deliveryId: "d", success: false, statusCode: 500, error: "HTTP 500", durationMs: 12, responseBody: "x", retryAt: new Date("2026-11-21T00:00:00Z") });
    expect(calls).toEqual([
      { fn: "claim_webhook_deliveries", args: { p_limit: 10, p_lease_seconds: 30 } },
      {
        fn: "record_webhook_attempt",
        args: {
          p_delivery_id: "d",
          p_success: false,
          p_status_code: 500,
          p_error: "HTTP 500",
          p_duration_ms: 12,
          p_response_body: "x",
          p_retry_at: "2026-11-21T00:00:00.000Z",
        },
      },
    ]);
  });

  it("maps event bus RPCs", async () => {
    const { client, calls } = fakeClient([{ queue_id: 7, attempts: 1, event: {} }]);
    const store = supabaseEventQueueStore(client);
    expect(await store.claim("automations", 5, 60)).toEqual([{ queueId: 7, attempts: 1, event: {} }]);
    await store.complete(7, true, null, null);
    expect(calls.map((c) => c.fn)).toEqual(["claim_events", "complete_event"]);
  });
});
