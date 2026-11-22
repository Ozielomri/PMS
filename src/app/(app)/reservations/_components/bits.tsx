import Link from "next/link";

import { Badge, cx } from "@/components/ui";
import { SOURCE_COLORS, SOURCE_LABELS, STATUS_LABELS, STATUS_TONE, STAY_LABELS, type ReservationSource, type ReservationStatus, type StayStatus } from "@/lib/reservations/status";

export function StatusBadge({ status, stay }: { status: ReservationStatus; stay?: StayStatus | null }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
      {stay && stay !== "upcoming" ? <Badge tone={stay === "no_show" ? "red" : "neutral"}>{STAY_LABELS[stay]}</Badge> : null}
    </span>
  );
}

export function SourceDot({ source }: { source: string }) {
  const s = source as ReservationSource;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span aria-hidden className={cx("inline-block h-2.5 w-2.5 rounded-full", SOURCE_COLORS[s] ?? "bg-slate-500")} />
      {SOURCE_LABELS[s] ?? source}
    </span>
  );
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Formats a listing-local date (YYYY-MM-DD) without shifting it through a timezone. */
export function formatDate(date: string | null | undefined, withWeekday = false): string {
  if (!date) return "—";
  return (withWeekday ? DAY_FMT : DATE_FMT).format(new Date(`${date}T00:00:00Z`));
}

export function StayDates({ checkIn, checkOut, nights }: { checkIn: string; checkOut: string; nights: number }) {
  return (
    <span className="whitespace-nowrap">
      {formatDate(checkIn)} → {formatDate(checkOut)} <span className="text-slate-500">({nights} night{nights === 1 ? "" : "s"})</span>
    </span>
  );
}

export function LinkButton({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex min-h-10 items-center rounded-full px-4 py-2 text-sm",
        primary
          ? "bg-brand-600 font-semibold text-white hover:bg-brand-700"
          : "border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
      )}
    >
      {children}
    </Link>
  );
}
