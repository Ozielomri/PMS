/** Input validation for the calendar route handlers. */
import { z } from "zod";

import { isIsoDate, nightsBetween } from "@/lib/calendar/dates";

export const MAX_STAY_NIGHTS = 365;

const isoDate = z.string().refine(isIsoDate, "expected a date as YYYY-MM-DD");

const stayFields = {
  listing_id: z.uuid(),
  check_in: isoDate,
  check_out: isoDate,
  guests: z.coerce.number().int().min(1).max(100).default(1),
};

const validStay = (q: { check_in: string; check_out: string }) => {
  if (!isIsoDate(q.check_in) || !isIsoDate(q.check_out)) return false;
  const n = nightsBetween(q.check_in, q.check_out);
  return n >= 1 && n <= MAX_STAY_NIGHTS;
};

const stayMessage = { message: `check_out must be 1 to ${MAX_STAY_NIGHTS} nights after check_in`, path: ["check_out"] };

export const availabilityQuerySchema = z.object(stayFields).refine(validStay, stayMessage);

export const quoteQuerySchema = z
  .object({ ...stayFields, pets: z.coerce.number().int().min(0).max(20).default(0) })
  .refine(validStay, stayMessage);

const nightsRule = z.number().int().min(1).max(365).nullable();

/** CAL-15: one rate/availability update for [from, to) on one listing. `price_cents: null` = back to base. */
export const pricingToolUpdateSchema = z
  .strictObject({
    listing_id: z.uuid(),
    from: isoDate,
    to: isoDate,
    price_cents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    min_nights: nightsRule.optional(),
    max_nights: nightsRule.optional(),
    closed_to_arrival: z.boolean().optional(),
    closed_to_departure: z.boolean().optional(),
    closed: z.boolean().optional(),
  })
  .refine((u) => isIsoDate(u.from) && isIsoDate(u.to) && nightsBetween(u.from, u.to) >= 1 && nightsBetween(u.from, u.to) <= 1100, {
    message: "to must be 1 to 1100 days after from",
    path: ["to"],
  })
  .refine(
    (u) => ["price_cents", "min_nights", "max_nights", "closed_to_arrival", "closed_to_departure", "closed"].some((k) => k in u),
    "an update must change at least one field",
  );

export const pricingToolPayloadSchema = z.strictObject({
  updates: z.array(pricingToolUpdateSchema).min(1).max(500),
});

export type PricingToolPayload = z.infer<typeof pricingToolPayloadSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}
