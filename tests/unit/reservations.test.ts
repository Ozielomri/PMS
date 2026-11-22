import { describe, expect, it } from "vitest";

import { reservationErrorMessage } from "@/lib/reservations/errors";
import { buildReservationsCsv, type ExportReservation } from "@/lib/reservations/export";
import { filtersToQuery, parseFilters, tabConstraints } from "@/lib/reservations/filters";
import { cancellationOutcome, refundPercent } from "@/lib/reservations/refunds";
import { blocksCalendar, canTransition, isFinal } from "@/lib/reservations/status";

describe("reservation filters (RES-13)", () => {
  it("parses known values and drops junk", () => {
    const f = parseFilters({ tab: "arriving", status: "confirmed", source: "airbnb", ci_from: "2026-12-01", ci_to: "nope", page: "3", balance: "due", listing: "x" });
    expect(f).toMatchObject({ tab: "arriving", status: "confirmed", source: "airbnb", checkInFrom: "2026-12-01", checkInTo: "", page: 3, balanceDue: true, listing: "" });
    expect(parseFilters({ tab: "bogus", status: "weird", page: "-4" })).toMatchObject({ tab: "upcoming", status: "", page: 1 });
  });

  it("round-trips through the URL", () => {
    const f = parseFilters({ tab: "pending", q: "smith", co_to: "2026-12-31", balance: "due" });
    expect(parseFilters(Object.fromEntries(new URLSearchParams(filtersToQuery(f))))).toEqual(f);
    expect(filtersToQuery(parseFilters({}))).toBe("");
  });

  it("maps quick tabs to constraints", () => {
    expect(tabConstraints("arriving", "2026-12-01")).toEqual({ statuses: ["confirmed"], checkInEq: "2026-12-01" });
    expect(tabConstraints("in_house", "2026-12-01")).toEqual({ statuses: ["confirmed"], stay: ["checked_in"] });
    expect(tabConstraints("all", "2026-12-01")).toEqual({});
  });
});

describe("reservation CSV export", () => {
  const row: ExportReservation = {
    code: "RABC1234", status: "confirmed", stay_status: "upcoming", kind: "guest", source: "direct", channel_reservation_id: null,
    listing: "Beach, house", unit: null, guest: "=cmd", guest_email: "a@b.test", guest_phone: null,
    check_in: "2026-12-01", check_out: "2026-12-04", nights: 3, adults: 2, children: 0, infants: 0, pets: 0,
    created_at: "2026-11-20T10:00:00Z", total_cents: 45050, paid_cents: 10000, balance_due_cents: 35050, currency: "USD",
  };

  it("adds money columns only when allowed, and escapes cells", () => {
    const [head, line] = buildReservationsCsv([row], true).trim().split("\r\n");
    expect(head.endsWith("Total,Paid,Balance due,Currency")).toBe(true);
    expect(line).toContain('"Beach, house"');
    expect(line).toContain("'=cmd");
    expect(line.endsWith("450.50,100.00,350.50,USD")).toBe(true);
    expect(buildReservationsCsv([row], false)).not.toContain("450.50");
  });
});

describe("reservation helpers", () => {
  it("maps database errors to readable text", () => {
    expect(reservationErrorMessage("calendar_conflict: nights not available: 2026-12-01 reservation (hold 0b1c2d3e-0000-0000-0000-000000000000)")).toBe(
      "Those nights are not available. (2026-12-01 reservation)",
    );
    expect(reservationErrorMessage("forbidden: nope")).toBe("You do not have permission to do that.");
    expect(reservationErrorMessage(undefined)).toBe("Something went wrong. Try again.");
  });

  it("status machine basics", () => {
    expect(canTransition("reserved", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "reserved")).toBe(false);
    expect(isFinal("canceled")).toBe(true);
    expect(blocksCalendar("reserved")).toBe(true);
    expect(blocksCalendar("inquiry")).toBe(false);
  });

  it("refunds", () => {
    expect(refundPercent("moderate", "guest", 4)).toBe(50);
    expect(refundPercent("strict", "host", 0)).toBe(100);
    expect(cancellationOutcome(10001, 3000, 50)).toEqual({ refundPercent: 50, keptCents: 5000, refundDueCents: 0, balanceDueCents: 2000 });
  });
});
