import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, Card, Skeleton, formatDateTime } from "@/components/ui";
import { formatMoney } from "@/lib/properties/money";
import { createClient } from "@/lib/supabase/server";

import { AcceptOption } from "./accept-option";

export const metadata: Metadata = { title: "Your quote", robots: { index: false, follow: false } };

export default function QuotePage({ params }: PageProps<"/q/[token]">) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Suspense fallback={<Skeleton lines={6} />}>
        <PublicQuote params={params} />
      </Suspense>
    </main>
  );
}

interface PublicQuoteData {
  status: "open" | "accepted" | "expired" | "canceled";
  expires_at: string;
  message: string | null;
  account_name: string;
  guest_first_name: string;
  accepted_option_id: string | null;
  options: {
    id: string;
    listing_title: string;
    city: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    adults: number;
    children: number;
    pets: number;
    currency: string | null;
    lines: { code: string; label: string; quantity?: number; amount_cents: number }[] | null;
    total_cents: number;
  }[];
}

const fmt = (d: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

async function PublicQuote({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = /^[0-9a-f]{48}$/.test(token) ? await supabase.rpc("get_quote", { p_token: token }) : { data: null };
  const q = data as PublicQuoteData | null;
  if (!q) {
    return (
      <Card title="Quote not found">
        <p className="text-sm text-slate-500">Check the link you received.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">{q.account_name}</p>
        <h1 className="mt-1 text-2xl font-semibold">Hi {q.guest_first_name}, here is your quote</h1>
        {q.status === "open" ? <p className="mt-1 text-sm text-slate-500">Valid until {formatDateTime(q.expires_at)} (Eastern time).</p> : null}
      </div>
      {q.message ? <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-900">{q.message}</p> : null}
      {q.status === "expired" ? <Alert>This quote has expired. Contact {q.account_name} for a new one.</Alert> : null}
      {q.status === "canceled" ? <Alert>This quote was withdrawn.</Alert> : null}
      {q.status === "accepted" ? <Alert tone="success">You booked this quote. Thank you!</Alert> : null}
      {q.options.map((o) => (
        <Card key={o.id} title={o.listing_title} description={o.city ?? undefined}>
          <p className="text-sm">
            {fmt(o.check_in)} → {fmt(o.check_out)} · {o.nights} night{o.nights === 1 ? "" : "s"} · {o.adults + o.children} guest{o.adults + o.children === 1 ? "" : "s"}
            {o.pets ? ` · ${o.pets} pet${o.pets === 1 ? "" : "s"}` : ""}
          </p>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {(o.lines ?? []).map((l) => (
                <tr key={l.code}>
                  <td className="py-1 text-slate-600 dark:text-slate-300">{l.label}</td>
                  <td className="py-1 text-right tabular-nums">{formatMoney(l.amount_cents, o.currency ?? "USD")}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                <td className="py-1">Total</td>
                <td className="py-1 text-right tabular-nums">{formatMoney(o.total_cents, o.currency ?? "USD")}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-4">
            {q.status === "open" ? (
              <AcceptOption token={token} optionId={o.id} label={`${o.listing_title}, ${fmt(o.check_in)} → ${fmt(o.check_out)}`} />
            ) : q.accepted_option_id === o.id ? (
              <Alert tone="success">Booked</Alert>
            ) : null}
          </div>
        </Card>
      ))}
      <p className="text-xs text-slate-400">Payment and house rules are arranged directly with {q.account_name}.</p>
    </div>
  );
}
