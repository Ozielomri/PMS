/**
 * RES-07 refund rules. Mirrors private.refund_percent and the kept-amount arithmetic of
 * public.cancel_reservation (migration 20261123002100); a DB test checks they match.
 *
 *   flexible        100 % if at least 1 day before check-in, else 0 %
 *   moderate        100 % if at least 5 days before, else 50 %
 *   strict          50 % if at least 7 days before, else 0 %
 *   non_refundable  0 %
 *   custom          0 % unless a manager enters a percentage
 *   host or channel cancellations always refund 100 %
 */

export type CanceledBy = "host" | "guest" | "channel";

export function refundPercent(policy: string, canceledBy: CanceledBy, daysBeforeCheckIn: number): number {
  if (canceledBy === "host" || canceledBy === "channel") return 100;
  switch (policy) {
    case "flexible":
      return daysBeforeCheckIn >= 1 ? 100 : 0;
    case "moderate":
      return daysBeforeCheckIn >= 5 ? 100 : 50;
    case "strict":
      return daysBeforeCheckIn >= 7 ? 50 : 0;
    default:
      return 0;
  }
}

export interface CancellationOutcome {
  refundPercent: number;
  keptCents: number;
  refundDueCents: number;
  balanceDueCents: number;
}

/** Amount kept after a cancellation, and what is owed either way given the payments so far. */
export function cancellationOutcome(guestTotalCents: number, paidCents: number, percent: number): CancellationOutcome {
  const refundable = Math.floor((guestTotalCents * percent + 50) / 100);
  const kept = guestTotalCents - refundable;
  return {
    refundPercent: percent,
    keptCents: kept,
    refundDueCents: Math.max(paidCents - kept, 0),
    balanceDueCents: Math.max(kept - paidCents, 0),
  };
}

export const POLICY_SUMMARIES: Record<string, string> = {
  flexible: "Full refund until 1 day before check-in.",
  moderate: "Full refund until 5 days before check-in, then 50 %.",
  strict: "50 % refund until 7 days before check-in, then none.",
  non_refundable: "No refund.",
  custom: "Refund decided case by case.",
};
