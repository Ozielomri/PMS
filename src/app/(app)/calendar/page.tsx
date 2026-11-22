import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Button, Input, PageHeader, Select, Skeleton, cx } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { addDays, isIsoDate } from "@/lib/calendar/dates";
import { loadGrid } from "@/lib/calendar/grid";
import { accountToday } from "@/lib/reservations/list";
import { createClient } from "@/lib/supabase/server";

import { CalendarGrid } from "./_components/calendar-grid";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Calendar searchParams={searchParams} />
    </Suspense>
  );
}

const ZOOMS = [7, 14, 31] as const;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

async function Calendar({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "calendar.view", returnTo: "/calendar" });
  const params = await searchParams;
  const supabase = await createClient();
  const { today } = await accountToday(supabase, ctx.active.accountId);
  const days = (ZOOMS as readonly number[]).includes(Number(params.days)) ? Number(params.days) : 14;
  const from = isIsoDate(str(params.from)) ? str(params.from) : addDays(today, -1);
  const q = str(params.q).slice(0, 100);
  const tag = str(params.tag).slice(0, 50);

  const { rows, bookings, tags } = await loadGrid(supabase, ctx.active.accountId, { from, to: addDays(from, days), q, tag });
  const link = (patch: Record<string, string | number>) => {
    const p = new URLSearchParams(Object.entries({ from, days, q, tag, ...patch }).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => [k, String(v)]));
    return `/calendar?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Calendar"
        description="All listings, night by night. Multi-units show free units; their bookings appear on the unit rows."
        actions={
          ctx.can("calendar.edit") ? (
            <Link href="/calendar/bulk" className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              Bulk edit
            </Link>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Link href={link({ from: addDays(from, -days) })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700" aria-label="Earlier">
            ←
          </Link>
          <Link href={link({ from: addDays(today, -1) })} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
            Today
          </Link>
          <Link href={link({ from: addDays(from, days) })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700" aria-label="Later">
            →
          </Link>
        </div>
        <div className="flex overflow-hidden rounded-md border border-slate-300 text-sm dark:border-slate-700" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <Link key={z} href={link({ days: z })} aria-current={z === days ? "true" : undefined} className={cx("px-3 py-1.5", z === days ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
              {z === 31 ? "Month" : `${z} days`}
            </Link>
          ))}
        </div>
        <form className="ml-auto flex flex-wrap items-center gap-2" role="search" aria-label="Calendar filters">
          <input type="hidden" name="days" value={days} />
          <Input type="date" name="from" defaultValue={from} aria-label="Jump to date" className="w-40" />
          <Input type="search" name="q" defaultValue={q} placeholder="Listing name" aria-label="Listing name" className="w-44" />
          <Select name="tag" defaultValue={tag} aria-label="Tag" className="w-36">
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Go
          </Button>
        </form>
      </div>
      <CalendarGrid
        from={from}
        days={days}
        today={today}
        rows={rows}
        bookings={bookings}
        can={{
          create: ctx.can("reservations.create"),
          block: ctx.can("calendar.block"),
          edit: ctx.can("calendar.edit"),
          moveReservations: ctx.can("reservations.edit"),
          seeMoney: ctx.can("reservations.view_money"),
        }}
      />
    </>
  );
}
