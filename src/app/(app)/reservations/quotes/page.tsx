import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { formatMoney } from "@/lib/properties/money";
import { createClient } from "@/lib/supabase/server";

import { cancelQuote } from "../actions";
import { LinkButton, formatDate } from "../_components/bits";

export const metadata: Metadata = { title: "Quotes" };

export default function QuotesPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Quotes />
    </Suspense>
  );
}

interface QuoteRow {
  id: string;
  status: "open" | "accepted" | "expired" | "canceled";
  expires_at: string;
  hold: boolean;
  created_at: string;
  reservation_id: string | null;
  guest: { first_name: string; last_name: string | null; email: string | null } | null;
  quote_options: { id: string; check_in: string; check_out: string; total_cents: number; listing: { internal_name: string } | null }[];
}

const TONE = { open: "amber", accepted: "green", expired: "neutral", canceled: "red" } as const;

async function Quotes() {
  const ctx = await requireAuthContext({ permission: "reservations.view", returnTo: "/reservations/quotes" });
  const supabase = await createClient();
  await supabase.rpc("expire_quotes");
  const { data } = await supabase
    .from("quotes")
    .select("id, status, expires_at, hold, created_at, reservation_id, guest:guests(first_name, last_name, email), quote_options(id, check_in, check_out, total_cents, listing:listings(internal_name))")
    .eq("account_id", ctx.active.accountId)
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<QuoteRow[]>();
  const canCreate = ctx.can("reservations.create");
  return (
    <>
      <PageHeader
        title="Quotes"
        description="Priced offers sent to guests as a link. Expired quotes free any held nights."
        actions={canCreate ? <LinkButton href="/reservations/quotes/new" primary>New quote</LinkButton> : undefined}
      />
      {(data ?? []).length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No quotes yet.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((q) => (
            <Card key={q.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {q.guest ? [q.guest.first_name, q.guest.last_name].filter(Boolean).join(" ") : "Guest"}{" "}
                    <span className="text-sm font-normal text-slate-500">{q.guest?.email}</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Created {formatDateTime(q.created_at)} · {q.status === "open" ? `expires ${formatDateTime(q.expires_at)}` : `expiry ${formatDateTime(q.expires_at)}`}
                    {q.hold ? " · nights held" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE[q.status]}>{q.status}</Badge>
                  {q.reservation_id ? (
                    <Link href={`/reservations/${q.reservation_id}`} className="text-sm underline">
                      Reservation
                    </Link>
                  ) : null}
                  {canCreate && q.status === "open" ? <ActionForm action={cancelQuote} fields={{ quoteId: q.id }} label="Withdraw" variant="ghost" confirm="Withdraw this quote?" /> : null}
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {q.quote_options.map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <span>
                      {o.listing?.internal_name} · {formatDate(o.check_in)} → {formatDate(o.check_out)}
                    </span>
                    {ctx.can("reservations.view_money") ? <span className="tabular-nums">{formatMoney(o.total_cents)}</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
