import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto/secrets";
import { deliverOnce, dispatchWebhooks, type AttemptResult, type ClaimedDelivery, type DeliveryStore } from "@/lib/webhooks/dispatcher";
import { verifySignature } from "@/lib/webhooks/signature";

const key = randomBytes(32);
const now = new Date("2026-11-21T12:00:00Z");

function delivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  const endpointId = overrides.endpointId ?? "ep-1";
  return {
    deliveryId: "del-1",
    accountId: "acc-1",
    attemptNumber: 1,
    endpointId,
    url: "https://hooks.example.com/pms",
    secretCiphertext: encryptSecret("whsec_abc", key, endpointId),
    event: { id: "evt-1", type: "account.updated", data: {} },
    ...overrides,
  };
}

const publicLookup = async () => [{ address: "93.184.216.34" }];
const base = { encryptionKey: key, lookup: publicLookup, now: () => now, random: () => 0.5 };

describe("deliverOnce", () => {
  it("POSTs the signed event and reports success", async () => {
    const fetchImpl = vi.fn(async () => new Response("thanks", { status: 202 }));
    const result = await deliverOnce(delivery(), { ...base, store: {} as DeliveryStore, fetchImpl });
    expect(result).toMatchObject({ success: true, statusCode: 202, responseBody: "thanks", retryAt: null });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/pms");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(verifySignature(headers["x-pms-signature"], "whsec_abc", init.body as string, { now })).toMatchObject({ ok: true });
  });

  it("schedules a retry after a 5xx or a network error", async () => {
    const r500 = await deliverOnce(delivery(), { ...base, store: {} as DeliveryStore, fetchImpl: async () => new Response("no", { status: 500 }) });
    expect(r500).toMatchObject({ success: false, statusCode: 500, error: "HTTP 500" });
    expect(r500.retryAt?.toISOString()).toBe("2026-11-21T12:00:30.000Z");

    const offline = await deliverOnce(delivery({ attemptNumber: 3 }), {
      ...base,
      store: {} as DeliveryStore,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(offline).toMatchObject({ success: false, statusCode: null, error: "fetch failed" });
    expect(offline.retryAt?.toISOString()).toBe("2026-11-21T12:02:00.000Z");
  });

  it("treats redirects as failures (never follows them)", async () => {
    const r = await deliverOnce(delivery(), {
      ...base,
      store: {} as DeliveryStore,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(r).toMatchObject({ success: false, statusCode: 302 });
  });

  it("does not retry 410 Gone, undecryptable secrets or blocked destinations", async () => {
    const gone = await deliverOnce(delivery(), { ...base, store: {} as DeliveryStore, fetchImpl: async () => new Response("", { status: 410 }) });
    expect(gone.retryAt).toBeNull();

    const fetchImpl = vi.fn();
    const badSecret = await deliverOnce(delivery({ secretCiphertext: "v1.x.y.z" }), { ...base, store: {} as DeliveryStore, fetchImpl });
    expect(badSecret).toMatchObject({ success: false, retryAt: null, error: "could not decrypt endpoint secret" });

    const ssrf = await deliverOnce(delivery(), { ...base, lookup: async () => [{ address: "10.0.0.1" }], store: {} as DeliveryStore, fetchImpl });
    expect(ssrf).toMatchObject({ success: false, retryAt: null });
    expect(ssrf.error).toMatch(/blocked destination/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("truncates large response bodies to 2 KB", async () => {
    const r = await deliverOnce(delivery(), { ...base, store: {} as DeliveryStore, fetchImpl: async () => new Response("x".repeat(10_000)) });
    expect(r.responseBody).toHaveLength(2048);
  });
});

describe("dispatchWebhooks", () => {
  it("records every claimed delivery and summarises the outcome", async () => {
    const recorded: AttemptResult[] = [];
    const statuses: Record<string, string> = { a: "succeeded", b: "pending", c: "failed" };
    const store: DeliveryStore = {
      claim: async () => ["a", "b", "c"].map((id) => delivery({ deliveryId: id })),
      record: async (r) => {
        recorded.push(r);
        return statuses[r.deliveryId];
      },
    };
    const summary = await dispatchWebhooks({ ...base, store, fetchImpl: async () => new Response("ok") });
    expect(summary).toEqual({ claimed: 3, succeeded: 1, retrying: 1, failed: 1 });
    expect(recorded.map((r) => r.deliveryId).sort()).toEqual(["a", "b", "c"]);
  });
});
