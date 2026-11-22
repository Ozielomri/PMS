import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { addDays, dayOfWeek, localToday } from "@/lib/calendar/dates";
import { loadGrid } from "@/lib/calendar/grid";
import { createClient } from "@/lib/supabase/server";

import { MonthCalendar } from "../_components/month-calendar";

export const metadata: Metadata = { title: "Listing calendar" };

export default function ListingCalendarPage({ params, searchParams }: PageProps<"/calendar/[listingId]">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <ListingCalendar params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

async function ListingCalendar({ params, searchParams }: { params: Promise<{ listingId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { listingId } = await params;
  const ctx = await requireAuthContext({ permission: "calendar.view", returnTo: `/calendar/${listingId}` });
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) notFound();
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: listing } = await supabase
    .from("listings")
    .select("id, internal_name, type, status, timezone, parent_id")
    .eq("id", listingId)
    .maybeSingle<{ id: string; internal_name: string; type: string; status: string; timezone: string; parent_id: string | null }>();
  if (!listing || listing.type === "complex") notFound();

  const today = localToday(listing.timezone);
  const month = typeof sp.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : today.slice(0, 7);
  const first = `${month}-01`;
  const gridStart = addDays(first, -dayOfWeek(first));
  const nextMonth = `${shiftMonth(month, 1)}-01`;
  const gridEnd = addDays(nextMonth, (7 - dayOfWeek(nextMonth)) % 7);
  const weeks: string[][] = [];
  for (let d = gridStart; d < gridEnd; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));

  const { rows, bookings } = await loadGrid(supabase, ctx.active.accountId, { from: gridStart, to: gridEnd, listingIds: [listing.id] });
  const row = rows.find((r) => r.id === listing.id);

  return (
    <>
      <PageHeader
        title={listing.internal_name}
        description={listing.type === "multi_parent" ? "Multi-unit: prices and rules here apply to the multi-unit; bookings shown are on its units." : `Times and dates in ${listing.timezone}.`}
        actions={
          <div className="flex items-center gap-2 text-sm">
            <Link href={`/calendar/${listing.id}?month=${shiftMonth(month, -1)}`} className="rounded-xl border border-slate-300 px-2 py-1.5 dark:border-slate-700" aria-label="Previous month">
              ←
            </Link>
            <span className="w-36 text-center font-medium">{MONTH_FMT.format(new Date(`${first}T00:00:00Z`))}</span>
            <Link href={`/calendar/${listing.id}?month=${shiftMonth(month, 1)}`} className="rounded-xl border border-slate-300 px-2 py-1.5 dark:border-slate-700" aria-label="Next month">
              →
            </Link>
            <Link href={`/calendar?from=${first}&days=31`} className="ml-2 underline">
              All listings
            </Link>
          </div>
        }
      />
      <MonthCalendar
        listing={{ id: listing.id, name: listing.internal_name, bookable: listing.status === "active" }}
        weeks={weeks}
        month={month}
        today={today}
        cells={row?.cells ?? {}}
        bookings={listing.type === "multi_parent" ? [] : bookings.filter((b) => b.listingId === listing.id)}
        can={{ create: ctx.can("reservations.create"), block: ctx.can("calendar.block"), edit: ctx.can("calendar.edit") }}
      />
    </>
  );
}
