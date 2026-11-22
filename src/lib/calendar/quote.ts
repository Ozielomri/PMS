/**
 * CAL-05 price quote. The database (`public.quote_stay`) is the source of truth; this mirrors
 * the same rules for previews, and tests/db/calendar-pricing.test.ts pins the two together.
 *
 *   total = Σ nightly prices + extra-guest fee (per guest above N, per night) + cleaning fee
 *           + pet fee (per stay) − length-of-stay discount (on the nightly sum only)
 *
 * Monthly discount from 28 nights, else weekly from 7. Basis points, rounded half-up. No taxes
 * in this phase. All amounts are integer cents.
 */

export type PriceSource = "base" | "weekend" | "override";

export interface QuoteNight {
  night: string;
  priceCents: number | null;
  source: PriceSource;
}

export interface QuoteInput {
  currency: string;
  nightly: QuoteNight[];
  guests: number;
  pets: number;
  cleaningFeeCents: number;
  extraGuestFeeCents: number;
  extraGuestAfter: number | null;
  petFeeCents: number;
  weeklyDiscountBps: number;
  monthlyDiscountBps: number;
}

export type QuoteLineCode = "accommodation" | "extra_guest_fee" | "cleaning_fee" | "pet_fee" | "weekly_discount" | "monthly_discount";

export interface QuoteLine {
  code: QuoteLineCode;
  label: string;
  quantity: number;
  unitAmountCents: number | null;
  amountCents: number;
}

export interface Quote {
  currency: string;
  nights: number;
  nightly: { night: string; priceCents: number; source: PriceSource }[];
  lines: QuoteLine[];
  totalCents: number;
}

export const WEEKLY_MIN_NIGHTS = 7;
export const MONTHLY_MIN_NIGHTS = 28;

/** round(amount × bps / 10000), half-up, for non-negative integers. */
export function applyBps(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps + 5000) / 10000);
}

export function computeQuote(input: QuoteInput): Quote {
  const missing = input.nightly.filter((n) => n.priceCents === null).map((n) => n.night);
  if (missing.length > 0) throw new Error(`price_missing: no price for ${missing.join(", ")}`);
  const nightly = input.nightly.map((n) => ({ night: n.night, priceCents: n.priceCents as number, source: n.source }));
  const nights = nightly.length;
  const accommodation = nightly.reduce((sum, n) => sum + n.priceCents, 0);

  const lines: QuoteLine[] = [
    {
      code: "accommodation",
      label: `${nights} ${nights === 1 ? "night" : "nights"}`,
      quantity: nights,
      unitAmountCents: null,
      amountCents: accommodation,
    },
  ];

  const extraGuests = input.extraGuestAfter === null ? 0 : Math.max(input.guests - input.extraGuestAfter, 0);
  if (extraGuests > 0 && input.extraGuestFeeCents > 0) {
    lines.push({
      code: "extra_guest_fee",
      label: "Extra guests",
      quantity: extraGuests * nights,
      unitAmountCents: input.extraGuestFeeCents,
      amountCents: extraGuests * nights * input.extraGuestFeeCents,
    });
  }
  if (input.cleaningFeeCents > 0) {
    lines.push({ code: "cleaning_fee", label: "Cleaning fee", quantity: 1, unitAmountCents: input.cleaningFeeCents, amountCents: input.cleaningFeeCents });
  }
  if (input.pets > 0 && input.petFeeCents > 0) {
    lines.push({ code: "pet_fee", label: "Pet fee", quantity: 1, unitAmountCents: input.petFeeCents, amountCents: input.petFeeCents });
  }

  let discount: { code: QuoteLineCode; name: string; bps: number } | null = null;
  if (nights >= MONTHLY_MIN_NIGHTS && input.monthlyDiscountBps > 0) {
    discount = { code: "monthly_discount", name: "Monthly", bps: input.monthlyDiscountBps };
  } else if (nights >= WEEKLY_MIN_NIGHTS && input.weeklyDiscountBps > 0) {
    discount = { code: "weekly_discount", name: "Weekly", bps: input.weeklyDiscountBps };
  }
  if (discount) {
    const amount = applyBps(accommodation, discount.bps);
    if (amount > 0) {
      lines.push({
        code: discount.code,
        label: `${discount.name} discount (${discount.bps / 100}%)`,
        quantity: 1,
        unitAmountCents: null,
        amountCents: -amount,
      });
    }
  }

  return { currency: input.currency, nights, nightly, lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0) };
}

/** Shape returned by public.quote_stay (snake_case JSON). */
export interface RpcQuote {
  listing_id: string;
  check_in: string;
  check_out: string;
  nights: number;
  currency: string;
  guests: number;
  pets: number;
  nightly: { night: string; price_cents: number; source: PriceSource }[];
  lines: { code: QuoteLineCode; label: string; quantity: number; unit_amount_cents: number | null; amount_cents: number }[];
  total_cents: number;
}

export function quoteFromRpc(q: RpcQuote): Quote {
  return {
    currency: q.currency,
    nights: q.nights,
    nightly: q.nightly.map((n) => ({ night: n.night, priceCents: n.price_cents, source: n.source })),
    lines: q.lines.map((l) => ({
      code: l.code,
      label: l.label,
      quantity: l.quantity,
      unitAmountCents: l.unit_amount_cents,
      amountCents: l.amount_cents,
    })),
    totalCents: q.total_cents,
  };
}
