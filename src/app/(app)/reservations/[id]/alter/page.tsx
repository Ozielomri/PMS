import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Alert, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { isChannelSource, isFinal, type ReservationStatus, type StayStatus } from "@/lib/reservations/status";
import { bookableListings } from "@/lib/reservations/listings";
import { createClient } from "@/lib/supabase/server";

import { LinkButton } from "../../_components/bits";
import { AlterForm } from "./alter-form";

export const metadata: Metadata = { title: "Change reservation" };

export default function AlterPage({ params }: PageProps<"/reservations/[id]/alter">) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Alter params={params} />
    </Suspense>
  );
}

async function Alter({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuthContext({ permission: "reservations.edit", returnTo: `/reservations/${id}/alter` });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: r } = await supabase
    .from("reservations")
    .select("id, code, kind, status, stay_status, source, listing_id, check_in, check_out, adults, children, infants, pets, currency")
    .eq("id", id)
    .maybeSingle<{ id: string; code: string; kind: string; status: ReservationStatus; stay_status: StayStatus | null; source: string; listing_id: string; check_in: string; check_out: string; adults: number; children: number; infants: number; pets: number; currency: string }>();
  if (!r) notFound();

  const blocked = isFinal(r.status) || isChannelSource(r.source) || r.stay_status === "checked_in" || r.stay_status === "checked_out";
  const listings = await bookableListings(supabase, ctx.active.accountId);

  return (
    <>
      <PageHeader title={`Change ${r.code}`} description="The calendar move is atomic: if the new nights are taken, nothing changes." actions={<LinkButton href={`/reservations/${r.id}`}>Back</LinkButton>} />
      {blocked ? (
        <Alert tone="error">
          {isChannelSource(r.source) ? "Channel bookings are changed on the channel." : "This reservation can no longer be changed."}
        </Alert>
      ) : (
        <AlterForm
          current={{ id: r.id, listingId: r.listing_id, checkIn: r.check_in, checkOut: r.check_out, adults: r.adults, children: r.children, infants: r.infants, pets: r.pets, currency: r.currency, ownerStay: r.kind === "owner_stay" }}
          listings={listings}
          canCustomPrice={ctx.can("reservations.manage")}
          canSeeMoney={ctx.can("reservations.view_money")}
        />
      )}
    </>
  );
}
