import { describe, expect, it } from "vitest";

import { processConsumer, type EventQueueStore } from "@/lib/events/bus";

const event = (n: number, type = "account.updated") => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  type,
  account_id: "00000000-0000-4000-8000-000000000001",
  occurred_at: "2026-11-21T12:00:00.000000Z",
  sequence: n,
  transaction_id: "1",
  entity: { type: "account", id: "x" },
  actor: { type: "user" as const, id: "u" },
  data: {},
});

function fakeStore(items: { queueId: number; attempts: number; event: unknown }[]) {
  const completed: { queueId: number; success: boolean; error: string | null; retryAt: Date | null }[] = [];
  const store: EventQueueStore = {
    claim: async () => items,
    complete: async (queueId, success, error, retryAt) => {
      completed.push({ queueId, success, error, retryAt });
    },
  };
  return { store, completed };
}

describe("processConsumer", () => {
  const now = () => new Date("2026-11-21T12:00:00Z");

  it("runs the handler in order and marks items done", async () => {
    const { store, completed } = fakeStore([1, 2, 3].map((n) => ({ queueId: n, attempts: 1, event: event(n) })));
    const seen: number[] = [];
    const summary = await processConsumer({ consumer: "c", store, now, handler: (e) => void seen.push(e.sequence) });
    expect(seen).toEqual([1, 2, 3]);
    expect(summary).toEqual({ consumer: "c", claimed: 3, done: 3, retrying: 0, failed: 0 });
    expect(completed.every((c) => c.success)).toBe(true);
  });

  it("retries a failing handler with backoff and keeps going", async () => {
    const { store, completed } = fakeStore([
      { queueId: 1, attempts: 1, event: event(1) },
      { queueId: 2, attempts: 1, event: event(2) },
    ]);
    const summary = await processConsumer({
      consumer: "c",
      store,
      now,
      random: () => 0.5,
      handler: (e) => {
        if (e.sequence === 1) throw new Error("nope");
      },
    });
    expect(summary).toMatchObject({ done: 1, retrying: 1 });
    expect(completed[0]).toMatchObject({ queueId: 1, success: false, error: "nope" });
    expect(completed[0].retryAt?.toISOString()).toBe("2026-11-21T12:00:10.000Z");
  });

  it("fails permanently after max attempts and on malformed envelopes", async () => {
    const { store, completed } = fakeStore([
      { queueId: 1, attempts: 10, event: event(1) },
      { queueId: 2, attempts: 1, event: { nonsense: true } },
    ]);
    const summary = await processConsumer({
      consumer: "c",
      store,
      now,
      handler: () => {
        throw new Error("down");
      },
    });
    expect(summary).toMatchObject({ failed: 2 });
    expect(completed.map((c) => c.retryAt)).toEqual([null, null]);
    expect(completed[1].error).toMatch(/invalid event envelope/);
  });
});
