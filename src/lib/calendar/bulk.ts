/**
 * CAL-12 bulk updates: the `changes` object accepted by public.update_calendar and the price
 * operations it applies (same arithmetic as the SQL, for previews in the UI).
 */
import { z } from "zod";

const MAX_CENTS = 100_000_000; // $1,000,000 per night

const hasAtMostTwoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-9;

export const priceOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), cents: z.number().int().min(0).max(MAX_CENTS) }),
  z.strictObject({ op: z.literal("add"), cents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS) }),
  z.strictObject({ op: z.literal("percent"), percent: z.number().min(-100).max(1000).refine(hasAtMostTwoDecimals, "at most two decimals") }),
  z.strictObject({ op: z.literal("reset") }),
]);

export type PriceOp = z.infer<typeof priceOpSchema>;

const nightsRule = z.number().int().min(1).max(365).nullable();

/** Keys map 1:1 to calendar_days override columns. `null` for min/max nights = listing default. */
export const calendarChangesSchema = z
  .strictObject({
    price: priceOpSchema.optional(),
    min_nights: nightsRule.optional(),
    max_nights: nightsRule.optional(),
    closed_to_arrival: z.boolean().optional(),
    closed_to_departure: z.boolean().optional(),
    closed: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, "no changes");

export type CalendarChanges = z.infer<typeof calendarChangesSchema>;

export function parseCalendarChanges(input: unknown): { ok: true; changes: CalendarChanges } | { ok: false; error: string } {
  const parsed = calendarChangesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "changes"}: ${i.message}`).join("; ") };
  return { ok: true, changes: parsed.data };
}

export type PriceOpResult = { kind: "set"; cents: number } | { kind: "reset" } | { kind: "skip" } | { kind: "negative" };

/** New override for a night whose effective price is `currentCents` (null = no price at all). */
export function applyPriceOp(currentCents: number | null, op: PriceOp): PriceOpResult {
  switch (op.op) {
    case "set":
      return { kind: "set", cents: op.cents };
    case "reset":
      return { kind: "reset" };
    case "add": {
      if (currentCents === null) return { kind: "skip" };
      const cents = currentCents + op.cents;
      return cents < 0 ? { kind: "negative" } : { kind: "set", cents };
    }
    case "percent": {
      if (currentCents === null) return { kind: "skip" };
      const hundredths = Math.round(op.percent * 100);
      // round(current × (100 % + p %)), half-up, in integer arithmetic.
      return { kind: "set", cents: Math.floor((currentCents * (10_000 + hundredths) + 5_000) / 10_000) };
    }
  }
}
