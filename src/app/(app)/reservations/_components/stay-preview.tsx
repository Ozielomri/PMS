"use client";

import { useEffect, useState } from "react";

import { Alert } from "@/components/ui";
import type { Quote } from "@/lib/calendar/quote";
import { formatMoney } from "@/lib/properties/money";

interface AvailabilityResult {
  bookable: boolean;
  message: string;
}

/** Live availability + itemised price for the stay being entered (CAL-02 / CAL-05 APIs). */
export function StayPreview({
  listingId,
  checkIn,
  checkOut,
  guests,
  pets,
  showPrice = true,
  onQuote,
}: {
  listingId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  pets: number;
  showPrice?: boolean;
  onQuote?: (q: Quote | null) => void;
}) {
  const [state, setState] = useState<{ quote: Quote | null; availability: AvailabilityResult | null; error: string | null; loading: boolean }>({
    quote: null,
    availability: null,
    error: null,
    loading: false,
  });
  const ready = Boolean(listingId && checkIn && checkOut && checkOut > checkIn);

  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    const qs = new URLSearchParams({ listing_id: listingId, check_in: checkIn, check_out: checkOut, guests: String(Math.max(guests, 1)), pets: String(pets) });
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const [a, q] = await Promise.all([
          fetch(`/api/calendar/availability?${qs}`, { signal: ctl.signal }).then((r) => r.json()),
          showPrice ? fetch(`/api/calendar/quote?${qs}`, { signal: ctl.signal }).then(async (r) => (r.ok ? ((await r.json()) as Quote) : null)) : Promise.resolve(null),
        ]);
        const availability = typeof a?.bookable === "boolean" ? (a as AvailabilityResult) : null;
        setState({ quote: q, availability, error: availability ? null : String(a?.error ?? "Could not check availability."), loading: false });
        onQuote?.(q);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setState((s) => ({ ...s, loading: false, error: "Could not check availability." }));
      }
    }, 300);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
    // onQuote is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, listingId, checkIn, checkOut, guests, pets, showPrice]);

  if (!ready) return <p className="text-sm text-slate-500">Choose a listing and dates to see availability and price.</p>;
  const { quote, availability, error, loading } = state;
  return (
    <div className="space-y-3" aria-live="polite">
      {loading ? <p className="text-sm text-slate-500">Checking…</p> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {availability ? (
        <Alert tone={availability.bookable ? "success" : "error"}>{availability.bookable ? "Available." : availability.message || "Not available."}</Alert>
      ) : null}
      {showPrice && quote ? (
        <table className="w-full text-sm">
          <tbody>
            {quote.lines.map((l) => (
              <tr key={l.code}>
                <td className="py-1 text-slate-600 dark:text-slate-300">
                  {l.label}
                  {l.quantity > 1 && l.unitAmountCents !== null ? <span className="text-slate-400"> ({l.quantity} × {formatMoney(l.unitAmountCents, quote.currency)})</span> : null}
                </td>
                <td className="py-1 text-right tabular-nums">{formatMoney(l.amountCents, quote.currency)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 font-medium dark:border-slate-700">
              <td className="py-1">Total ({quote.nights} night{quote.nights === 1 ? "" : "s"})</td>
              <td className="py-1 text-right tabular-nums">{formatMoney(quote.totalCents, quote.currency)}</td>
            </tr>
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
