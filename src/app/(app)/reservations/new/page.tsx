import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { isIsoDate } from "@/lib/calendar/dates";
import { bookableListings } from "@/lib/reservations/listings";
import { createClient } from "@/lib/supabase/server";

import { NewReservationForm } from "./new-reservation-form";

export const metadata: Metadata = { title: "New reservation" };

export default function NewReservationPage({ searchParams }: PageProps<"/reservations/new">) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <NewReservation searchParams={searchParams} />
    </Suspense>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** RES-01 manual booking (also opened from a calendar drag-select with listing and dates). */
async function NewReservation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "reservations.create", returnTo: "/reservations/new" });
  const params = await searchParams;
  const supabase = await createClient();
  const listings = await bookableListings(supabase, ctx.active.accountId);

  const listingId = str(params.listing);
  const checkIn = str(params.check_in);
  const checkOut = str(params.check_out);
  return (
    <>
      <PageHeader title="New reservation" description="Availability is checked again when you save; the nights are held atomically." />
      <NewReservationForm
        listings={listings}
        initial={{
          listingId: listings.some((l) => l.id === listingId) ? listingId : "",
          checkIn: isIsoDate(checkIn) ? checkIn : "",
          checkOut: isIsoDate(checkOut) ? checkOut : "",
          kind: str(params.kind) === "owner_stay" ? "owner_stay" : "guest",
        }}
        canOverride={ctx.can("reservations.view_money")}
        canSeeMoney={ctx.can("reservations.view_money")}
      />
    </>
  );
}
