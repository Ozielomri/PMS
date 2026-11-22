"use client";

import Link from "next/link";
import { useState } from "react";

import { cx } from "@/components/ui";
import type { GridBooking, GridCell } from "@/lib/calendar/grid";
import { SOURCE_COLORS, type ReservationSource } from "@/lib/reservations/status";

import { RangeMenu, type MenuPermissions } from "./range-menu";

/** Single-listing month view: click a first and a last night to select, then act on the range. */
export function MonthCalendar({
  listing,
  weeks,
  month,
  today,
  cells,
  bookings,
  can,
}: {
  listing: { id: string; name: string; bookable: boolean };
  weeks: string[][];
  month: string;
  today: string;
  cells: Record<string, GridCell>;
  bookings: GridBooking[];
  can: MenuPermissions;
}) {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [range, setRange] = useState<{ first: string; last: string } | null>(null);

  const bookingOn = (date: string) => bookings.find((b) => b.checkIn <= date && date < b.checkOut);
  const inRange = (date: string) => (range ? date >= range.first && date <= range.last : anchor === date);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-2">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7 border-b border-slate-100 last:border-0 dark:border-slate-800">
            {week.map((date) => {
              const cell = cells[date];
              const b = bookingOn(date);
              const outside = !date.startsWith(month);
              return (
                <button
                  key={date}
                  type="button"
                  disabled={!cell}
                  aria-pressed={inRange(date)}
                  aria-label={`${date}${b ? `, booked by ${b.guestName ?? "a booking"}` : cell?.block ? ", blocked" : ""}`}
                  onClick={() => {
                    if (!anchor || range) {
                      setAnchor(date);
                      setRange(null);
                    } else {
                      setRange(date < anchor ? { first: date, last: anchor } : { first: anchor, last: date });
                    }
                  }}
                  className={cx(
                    "relative flex h-24 flex-col items-stretch border-r border-slate-100 p-1.5 text-left text-xs last:border-r-0 dark:border-slate-800",
                    outside && "text-slate-300 dark:text-slate-600",
                    date < today && "bg-slate-50 dark:bg-slate-950/40",
                    cell?.block && "bg-[repeating-linear-gradient(135deg,var(--color-slate-200)_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(135deg,var(--color-slate-700)_0_4px,transparent_4px_9px)]",
                    cell?.closed && !cell.block && "bg-slate-200/70 dark:bg-slate-800",
                    inRange(date) && "!bg-sky-200 dark:!bg-sky-800",
                  )}
                >
                  <span className={cx("font-medium", date === today && "inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-600 text-white")}>{Number(date.slice(8))}</span>
                  {b ? (
                    <span className={cx("mt-1 truncate rounded px-1 py-0.5 text-[11px] text-white", b.sourceType === "quote" ? "bg-amber-500" : (SOURCE_COLORS[(b.source ?? "other") as ReservationSource] ?? "bg-slate-600"))}>
                      {b.checkIn === date || date.endsWith("-01") || week[0] === date ? (b.sourceType === "quote" ? "Quote hold" : (b.guestName ?? "Booked")) : " "}
                    </span>
                  ) : null}
                  {cell ? (
                    <span className="mt-auto flex items-end justify-between text-slate-500">
                      <span className={cx("tabular-nums", cell.priceSource === "override" && "font-semibold text-slate-800 dark:text-slate-100")}>
                        {cell.price === null ? "—" : `$${Math.round(cell.price / 100)}`}
                      </span>
                      {cell.minNights > 1 ? <span>{cell.minNights}n</span> : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="space-y-4">
        {range ? (
          <RangeMenu selection={{ listingId: listing.id, listingName: listing.name, ...range }} can={can} bookable={listing.bookable} onClose={() => setRange(null)} />
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
            {anchor ? "Now click the last night of the range." : "Click the first night, then the last night, to book, block or change prices."}
          </p>
        )}
        <div className="rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-800">
          <h2 className="mb-2 font-medium">Bookings this month</h2>
          <ul className="space-y-1">
            {bookings.map((b) => (
              <li key={b.holdId}>
                {b.reservationId ? (
                  <Link href={`/reservations/${b.reservationId}`} className="underline-offset-2 hover:underline">
                    {b.guestName ?? "Booking"} {b.code ? `· ${b.code}` : ""}
                  </Link>
                ) : (
                  "Quote hold"
                )}{" "}
                <span className="text-slate-500">
                  {b.checkIn} → {b.checkOut}
                </span>
              </li>
            ))}
            {bookings.length === 0 ? <li className="text-slate-500">None.</li> : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
