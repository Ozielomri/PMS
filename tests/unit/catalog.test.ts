import { describe, expect, it } from "vitest";

import { ALL_EVENT_TYPES, eventTypeMatches, isValidEventPattern } from "@/lib/events/catalog";

describe("event catalog (X-04)", () => {
  it("includes every event the requirements name", () => {
    for (const t of [
      "calendar.updated",
      "reservation.created",
      "reservation.updated",
      "reservation.status_changed",
      "reservation.dates_changed",
      "message.received",
      "message.sent",
      "task.created",
      "task.updated",
      "task.completed",
    ]) {
      expect(ALL_EVENT_TYPES).toContain(t);
    }
  });

  it("matches like private.event_type_matches", () => {
    expect(eventTypeMatches(["*"], "task.completed")).toBe(true);
    expect(eventTypeMatches(["reservation.*"], "reservation.status_changed")).toBe(true);
    expect(eventTypeMatches(["reservation.*"], "reservations.created")).toBe(false);
    expect(eventTypeMatches(["task.completed"], "task.created")).toBe(false);
    expect(eventTypeMatches([], "task.created")).toBe(false);
  });

  it("validates subscription patterns", () => {
    expect(isValidEventPattern("*")).toBe(true);
    expect(isValidEventPattern("reservation.*")).toBe(true);
    expect(isValidEventPattern("membership.removed")).toBe(true);
    expect(isValidEventPattern("reservation.deleted")).toBe(false);
    expect(isValidEventPattern("foo.*")).toBe(false);
    expect(isValidEventPattern("RESERVATION.*")).toBe(false);
    expect(isValidEventPattern("reservation.*.x")).toBe(false);
  });
});
