import { describe, expect, it } from "vitest";

import { WEBHOOK_BACKOFF, backoffDelayMs, nextRetryAt } from "@/lib/retry/backoff";

const mid = () => 0.5; // no jitter
describe("backoff", () => {
  it("doubles from 30 s and caps at 1 h", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => backoffDelayMs(n, { random: mid }));
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
    expect(backoffDelayMs(500, { random: mid })).toBe(3_600_000);
  });

  it("applies ±20 % jitter", () => {
    expect(backoffDelayMs(1, { random: () => 0 })).toBe(24_000);
    expect(backoffDelayMs(1, { random: () => 1 })).toBe(36_000);
  });

  it("stops at the deadline or after max attempts", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(nextRetryAt({ attempt: 1, now, random: mid })?.toISOString()).toBe("2026-11-21T12:00:30.000Z");
    expect(nextRetryAt({ attempt: 1, now, random: mid, deadline: new Date("2026-11-21T12:00:10Z") })).toBeNull();
    expect(nextRetryAt({ attempt: 3, now, random: mid, maxAttempts: 3 })).toBeNull();
  });

  it("keeps retrying for about 24 hours with the webhook schedule", () => {
    const start = new Date("2026-11-21T00:00:00Z");
    const deadline = new Date(start.getTime() + WEBHOOK_BACKOFF.windowMs);
    let now = start;
    let attempts = 1;
    for (;;) {
      const next = nextRetryAt({ attempt: attempts, now, deadline, random: mid, ...WEBHOOK_BACKOFF });
      if (!next) break;
      now = next;
      attempts++;
    }
    expect(attempts).toBeGreaterThan(25);
    expect(deadline.getTime() - now.getTime()).toBeLessThan(WEBHOOK_BACKOFF.maxDelayMs);
  });
});
