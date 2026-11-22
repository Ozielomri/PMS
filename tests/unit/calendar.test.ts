import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/routes";
import { applyPriceOp, parseCalendarChanges } from "@/lib/calendar/bulk";
import { addDays, dayOfWeek, eachNight, firstBookableDate, isIsoDate, localToday, nightsBetween } from "@/lib/calendar/dates";
import { bearerToken, calendarErrorBody, statusForCalendarError } from "@/lib/calendar/http";
import { computeQuote, quoteFromRpc, type QuoteInput } from "@/lib/calendar/quote";
import { availabilityQuerySchema, pricingToolPayloadSchema, quoteQuerySchema } from "@/lib/calendar/schemas";
import { CalendarError } from "@/lib/calendar/service";

describe("calendar dates", () => {
  it("validates ISO dates strictly", () => {
    expect(isIsoDate("2026-05-10")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-5-10")).toBe(false);
    expect(isIsoDate("2026-05-10T00:00:00Z")).toBe(false);
  });

  it("treats the check-out day as not a booked night", () => {
    expect(nightsBetween("2026-05-10", "2026-05-13")).toBe(3);
    expect(eachNight("2026-05-10", "2026-05-13")).toEqual(["2026-05-10", "2026-05-11", "2026-05-12"]);
    expect(eachNight("2026-05-10", "2026-05-10")).toEqual([]);
  });

  it("adds days across month, year and DST boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // US DST starts
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(nightsBetween("2026-01-01", "2028-01-01")).toBe(730);
  });

  it("uses Postgres day-of-week numbering (0 = Sunday)", () => {
    expect(dayOfWeek("2026-11-22")).toBe(0);
    expect(dayOfWeek("2026-11-27")).toBe(5);
  });

  it("evaluates today and advance notice in the listing timezone", () => {
    const now = new Date("2026-11-22T08:30:00Z"); // 03:30 in New York, 22:30 the day before in Honolulu
    expect(localToday("America/New_York", now)).toBe("2026-11-22");
    expect(localToday("Pacific/Honolulu", now)).toBe("2026-11-21");
    expect(firstBookableDate("America/New_York", 0, now)).toBe("2026-11-22");
    expect(firstBookableDate("America/New_York", 24, now)).toBe("2026-11-23");
    expect(firstBookableDate("Pacific/Honolulu", 2, now)).toBe("2026-11-22");
  });
});

describe("price quote (CAL-05)", () => {
  const base: QuoteInput = {
    currency: "USD",
    nightly: [
      { night: "2026-12-04", priceCents: 20000, source: "weekend" },
      { night: "2026-12-05", priceCents: 20000, source: "weekend" },
      { night: "2026-12-06", priceCents: 15000, source: "base" },
    ],
    guests: 2,
    pets: 0,
    cleaningFeeCents: 7500,
    extraGuestFeeCents: 2000,
    extraGuestAfter: 2,
    petFeeCents: 3000,
    weeklyDiscountBps: 1000,
    monthlyDiscountBps: 2000,
  };

  it("sums nightly prices and fees as itemised integer-cent lines", () => {
    const q = computeQuote(base);
    expect(q.nights).toBe(3);
    expect(q.lines).toEqual([
      { code: "accommodation", label: "3 nights", quantity: 3, unitAmountCents: null, amountCents: 55000 },
      { code: "cleaning_fee", label: "Cleaning fee", quantity: 1, unitAmountCents: 7500, amountCents: 7500 },
    ]);
    expect(q.totalCents).toBe(62500);
  });

  it("charges extra guests per night above the threshold and pets per stay", () => {
    const q = computeQuote({ ...base, guests: 4, pets: 1 });
    expect(q.lines.map((l) => [l.code, l.quantity, l.amountCents])).toEqual([
      ["accommodation", 3, 55000],
      ["extra_guest_fee", 6, 12000],
      ["cleaning_fee", 1, 7500],
      ["pet_fee", 1, 3000],
    ]);
    expect(q.totalCents).toBe(77500);
  });

  it("applies the weekly discount from 7 nights and the monthly one from 28, to the nightly sum only", () => {
    const week = Array.from({ length: 7 }, (_, i) => ({ night: addDays("2026-12-01", i), priceCents: 10001, source: "base" as const }));
    const q7 = computeQuote({ ...base, nightly: week });
    expect(q7.lines.at(-1)).toEqual({ code: "weekly_discount", label: "Weekly discount (10%)", quantity: 1, unitAmountCents: null, amountCents: -7001 });
    expect(q7.totalCents).toBe(70007 + 7500 - 7001);

    const month = Array.from({ length: 28 }, (_, i) => ({ night: addDays("2026-12-01", i), priceCents: 10000, source: "base" as const }));
    const q28 = computeQuote({ ...base, nightly: month, monthlyDiscountBps: 1250 });
    expect(q28.lines.at(-1)).toMatchObject({ code: "monthly_discount", label: "Monthly discount (12.5%)", amountCents: -35000 });

    const noMonthly = computeQuote({ ...base, nightly: month, monthlyDiscountBps: 0 });
    expect(noMonthly.lines.at(-1)).toMatchObject({ code: "weekly_discount", amountCents: -28000 });
  });

  it("rounds discounts half-up", () => {
    const week = Array.from({ length: 7 }, (_, i) => ({ night: addDays("2026-12-01", i), priceCents: i === 0 ? 5 : 0, source: "override" as const }));
    // 5 cents × 10 % = 0.5 → 1
    expect(computeQuote({ ...base, cleaningFeeCents: 0, nightly: week }).lines.at(-1)).toMatchObject({ amountCents: -1 });
  });

  it("refuses to quote nights without a price", () => {
    expect(() => computeQuote({ ...base, nightly: [{ night: "2026-12-04", priceCents: null, source: "base" }] })).toThrow(/price_missing/);
  });

  it("maps the SQL quote shape", () => {
    const q = quoteFromRpc({
      listing_id: "l",
      check_in: "2026-12-04",
      check_out: "2026-12-05",
      nights: 1,
      currency: "USD",
      guests: 1,
      pets: 0,
      nightly: [{ night: "2026-12-04", price_cents: 100, source: "base" }],
      lines: [{ code: "accommodation", label: "1 night", quantity: 1, unit_amount_cents: null, amount_cents: 100 }],
      total_cents: 100,
    });
    expect(q).toEqual({
      currency: "USD",
      nights: 1,
      nightly: [{ night: "2026-12-04", priceCents: 100, source: "base" }],
      lines: [{ code: "accommodation", label: "1 night", quantity: 1, unitAmountCents: null, amountCents: 100 }],
      totalCents: 100,
    });
  });
});

describe("bulk updates (CAL-12)", () => {
  it("applies price operations in integer cents", () => {
    expect(applyPriceOp(15000, { op: "set", cents: 9900 })).toEqual({ kind: "set", cents: 9900 });
    expect(applyPriceOp(15000, { op: "add", cents: -2500 })).toEqual({ kind: "set", cents: 12500 });
    expect(applyPriceOp(15000, { op: "percent", percent: 10 })).toEqual({ kind: "set", cents: 16500 });
    expect(applyPriceOp(12345, { op: "percent", percent: 10 })).toEqual({ kind: "set", cents: 13580 }); // 13579.5 → half-up
    expect(applyPriceOp(10000, { op: "percent", percent: -12.5 })).toEqual({ kind: "set", cents: 8750 });
    expect(applyPriceOp(15000, { op: "reset" })).toEqual({ kind: "reset" });
    expect(applyPriceOp(null, { op: "add", cents: 100 })).toEqual({ kind: "skip" });
    expect(applyPriceOp(null, { op: "set", cents: 100 })).toEqual({ kind: "set", cents: 100 });
    expect(applyPriceOp(1000, { op: "add", cents: -1001 })).toEqual({ kind: "negative" });
  });

  it("validates the changes object sent to update_calendar", () => {
    expect(parseCalendarChanges({ price: { op: "percent", percent: 15 }, min_nights: 3, closed_to_arrival: true })).toEqual({
      ok: true,
      changes: { price: { op: "percent", percent: 15 }, min_nights: 3, closed_to_arrival: true },
    });
    expect(parseCalendarChanges({ min_nights: null }).ok).toBe(true); // reset to listing default
    expect(parseCalendarChanges({}).ok).toBe(false);
    expect(parseCalendarChanges({ price: { op: "percent", percent: 12.345 } }).ok).toBe(false);
    expect(parseCalendarChanges({ min_nights: 0 }).ok).toBe(false);
    expect(parseCalendarChanges({ colour: "red" }).ok).toBe(false);
  });
});

describe("calendar API input", () => {
  const id = "4f0c3d0e-8c2b-4f7e-9a59-1f2d3c4b5a69";

  it("parses availability and quote queries", () => {
    expect(availabilityQuerySchema.parse({ listing_id: id, check_in: "2026-12-01", check_out: "2026-12-03" })).toEqual({
      listing_id: id,
      check_in: "2026-12-01",
      check_out: "2026-12-03",
      guests: 1,
    });
    expect(availabilityQuerySchema.safeParse({ listing_id: id, check_in: "2026-12-03", check_out: "2026-12-01" }).success).toBe(false);
    expect(quoteQuerySchema.parse({ listing_id: id, check_in: "2026-12-01", check_out: "2026-12-03", guests: "3", pets: "1" })).toMatchObject({
      guests: 3,
      pets: 1,
    });
  });

  it("parses pricing-tool payloads", () => {
    const ok = pricingToolPayloadSchema.safeParse({
      updates: [{ listing_id: id, from: "2026-12-01", to: "2026-12-08", price_cents: 18000, min_nights: 2, closed: false }],
    });
    expect(ok.success).toBe(true);
    expect(pricingToolPayloadSchema.safeParse({ updates: [] }).success).toBe(false);
    expect(pricingToolPayloadSchema.safeParse({ updates: [{ listing_id: id, from: "2026-12-01", to: "2026-12-08" }] }).success).toBe(false);
    expect(pricingToolPayloadSchema.safeParse({ updates: [{ listing_id: id, from: "2026-12-01", to: "2026-12-08", price_cents: 1.5 }] }).success).toBe(
      false,
    );
  });
});

describe("calendar HTTP helpers", () => {
  it("maps SQLSTATEs from the calendar API to HTTP statuses", () => {
    expect(statusForCalendarError("23P01")).toBe(409);
    expect(statusForCalendarError("42501")).toBe(403);
    expect(statusForCalendarError("P0002")).toBe(404);
    expect(statusForCalendarError("22023")).toBe(400);
    expect(statusForCalendarError("28000")).toBe(401);
    expect(statusForCalendarError("XX000")).toBe(500);
    const conflict = new CalendarError("calendar_conflict: reservation r1", "23P01");
    expect(conflict.isConflict).toBe(true);
    expect(calendarErrorBody(conflict)).toEqual({ status: 409, body: { error: "calendar_conflict: reservation r1", code: "23P01" } });
    expect(calendarErrorBody(new Error("boom"))).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("reads bearer tokens and exposes only the machine endpoints without a session", () => {
    expect(bearerToken("Bearer pmspt_abc")).toBe("pmspt_abc");
    expect(bearerToken("Basic x")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(isPublicPath("/api/calendar/machine/pricing-tool")).toBe(true);
    expect(isPublicPath("/api/calendar/machine/maintenance")).toBe(true);
    expect(isPublicPath("/api/calendar/availability")).toBe(false);
  });
});
