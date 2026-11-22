import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { addDays, isIsoDate } from "@/lib/calendar/dates";
import { accountToday } from "@/lib/reservations/list";
import { createClient } from "@/lib/supabase/server";

import { BulkForm } from "./bulk-form";

export const metadata: Metadata = { title: "Bulk calendar edit" };

export default function BulkPage({ searchParams }: PageProps<"/calendar/bulk">) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Bulk searchParams={searchParams} />
    </Suspense>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

async function Bulk({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "calendar.edit", returnTo: "/calendar/bulk" });
  const sp = await searchParams;
  const supabase = await createClient();
  const { today } = await accountToday(supabase, ctx.active.accountId);
  const { data } = await supabase
    .from("listings")
    .select("id, internal_name, type, parent_id")
    .eq("account_id", ctx.active.accountId)
    .neq("status", "archived")
    .neq("type", "complex")
    .order("internal_name")
    .limit(500)
    .returns<{ id: string; internal_name: string; type: string; parent_id: string | null }[]>();
  const rows = data ?? [];
  const listings = rows
    .filter((r) => r.type !== "sub_unit")
    .flatMap((r) => [{ id: r.id, name: r.internal_name, indent: false }, ...rows.filter((s) => s.parent_id === r.id).map((s) => ({ id: s.id, name: s.internal_name, indent: true }))]);
  const listing = str(sp.listing);
  const from = isIsoDate(str(sp.from)) ? str(sp.from) : today;
  const to = isIsoDate(str(sp.to)) && str(sp.to) > from ? str(sp.to) : addDays(from, 30);
  return (
    <>
      <PageHeader title="Bulk calendar edit" description="Change prices and rules for many listings and nights at once. Preview first; nothing changes until you apply." />
      <BulkForm listings={listings} initial={{ listingIds: listings.some((l) => l.id === listing) ? [listing] : [], from, to }} />
    </>
  );
}
