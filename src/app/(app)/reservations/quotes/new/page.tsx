import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { isIsoDate } from "@/lib/calendar/dates";
import { siteUrl } from "@/lib/env";
import { bookableListings } from "@/lib/reservations/listings";
import { createClient } from "@/lib/supabase/server";

import { QuoteForm } from "./quote-form";

export const metadata: Metadata = { title: "New quote" };

export default function NewQuotePage({ searchParams }: PageProps<"/reservations/quotes/new">) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <NewQuote searchParams={searchParams} />
    </Suspense>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

async function NewQuote({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "reservations.create", returnTo: "/reservations/quotes/new" });
  const params = await searchParams;
  const listings = await bookableListings(await createClient(), ctx.active.accountId);
  const listing = str(params.listing);
  const ci = str(params.check_in);
  const co = str(params.check_out);
  return (
    <>
      <PageHeader title="New quote" description="Prices are fixed when the quote is created; the guest books one option from the link." />
      <QuoteForm
        listings={listings}
        origin={siteUrl()}
        initial={{
          listing_id: listings.some((l) => l.id === listing) ? listing : "",
          check_in: isIsoDate(ci) ? ci : "",
          check_out: isIsoDate(co) ? co : "",
          adults: 2,
          children: 0,
          pets: 0,
        }}
      />
    </>
  );
}
