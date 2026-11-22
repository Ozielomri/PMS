"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Alert, Button, cx } from "@/components/ui";
import { addDays, dayOfWeek, nightsBetween } from "@/lib/calendar/dates";
import type { GridBooking, GridCell, GridRow } from "@/lib/calendar/grid";
import { formatMoney } from "@/lib/properties/money";
import { SOURCE_COLORS, SOURCE_LABELS, STATUS_LABELS, isChannelSource, type ReservationSource, type ReservationStatus } from "@/lib/reservations/status";

import { reassignUnit, relocateReservation, type AlterPreview } from "../../reservations/actions";
import { RangeMenu, type MenuPermissions, type Selection } from "./range-menu";

const NAME_COL = 220;
const COL_WIDTH: Record<number, number> = { 7: 120, 14: 76, 31: 48 };
const ROW_H = 52;

interface Props {
  from: string;
  days: number;
  today: string;
  rows: GridRow[];
  bookings: GridBooking[];
  can: MenuPermissions & { moveReservations: boolean; seeMoney: boolean };
}

type Drag = { rowId: string; a: number; b: number } | null;
type Move = { booking: GridBooking; target: GridRow; checkIn: string; checkOut: string } | null;

const short = (cents: number | null) => (cents === null ? "—" : `$${Math.round(cents / 100).toLocaleString("en-US")}`);
const fmtDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const fmtDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const d = (s: string) => new Date(`${s}T00:00:00Z`);

function barColor(b: GridBooking): string {
  if (b.sourceType === "quote") return "bg-amber-500";
  if (b.status === "reserved") return "bg-amber-600";
  return SOURCE_COLORS[(b.source ?? "other") as ReservationSource] ?? "bg-slate-600";
}

/** CAL screens: the multi-calendar. Rows are listings (multi-units with their units), columns are nights. */
export function CalendarGrid({ from, days, today, rows, bookings, can }: Props) {
  const colW = COL_WIDTH[days] ?? 76;
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const [drag, setDrag] = useState<Drag>(null);
  const [menu, setMenu] = useState<{ selection: Selection; x: number; y: number; bookable: boolean } | null>(null);
  const [panel, setPanel] = useState<GridBooking | null>(null);
  const [move, setMove] = useState<Move>(null);
  const grab = useRef<{ booking: GridBooking; offset: number } | null>(null);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const finishDrag = useCallback(
    (e: PointerEvent) => {
      setDrag((cur) => {
        if (!cur) return null;
        const row = rowById.get(cur.rowId);
        if (row) {
          const [lo, hi] = cur.a <= cur.b ? [cur.a, cur.b] : [cur.b, cur.a];
          setMenu({
            selection: { listingId: row.id, listingName: row.name, first: dates[lo], last: dates[hi] },
            x: Math.min(e.clientX, window.innerWidth - 340),
            y: Math.min(e.clientY, window.innerHeight - 380),
            bookable: row.status === "active",
          });
        }
        return null;
      });
    },
    [dates, rowById],
  );

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointerup", finishDrag, { once: true });
    return () => window.removeEventListener("pointerup", finishDrag);
  }, [drag, finishDrag]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setPanel(null);
        setMove(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dayIndexAt = (e: React.DragEvent | React.PointerEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(days - 1, Math.floor((e.clientX - rect.left - NAME_COL) / colW)));
  };

  if (rows.length === 0) return <p className="rounded-lg border border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800">No listings match.</p>;

  return (
    <div className="relative">
      <div className="max-h-[72vh] overflow-auto rounded-lg border border-slate-200 bg-white select-none dark:border-slate-800 dark:bg-slate-900" role="grid" aria-label="Multi-calendar" aria-rowcount={rows.length + 1}>
        <div style={{ width: NAME_COL + colW * days }}>
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800" role="row">
            <div className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800" style={{ width: NAME_COL }} role="columnheader">
              Listing
            </div>
            {dates.map((date) => {
              const dow = dayOfWeek(date);
              return (
                <div
                  key={date}
                  role="columnheader"
                  className={cx(
                    "shrink-0 border-r border-slate-200 py-1 text-center text-xs dark:border-slate-700",
                    (dow === 5 || dow === 6) && "bg-slate-100 dark:bg-slate-700/50",
                    date === today && "bg-sky-100 font-semibold text-sky-900 dark:bg-sky-900 dark:text-sky-100",
                  )}
                  style={{ width: colW }}
                >
                  <div className="text-slate-500">{fmtDay.format(d(date))}</div>
                  <div>{colW >= 60 ? fmtDate.format(d(date)) : d(date).getUTCDate()}</div>
                </div>
              );
            })}
          </div>

          {rows.map((row) => {
            const rowBookings = bookings.filter((b) => b.listingId === row.id);
            const parent = row.type === "multi_parent";
            return (
              <div
                key={row.id}
                role="row"
                className={cx("relative flex border-b border-slate-100 dark:border-slate-800", row.type === "sub_unit" && "bg-slate-50/50 dark:bg-slate-900/60")}
                style={{ height: ROW_H }}
                onDragOver={(e) => {
                  if (grab.current) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const g = grab.current;
                  grab.current = null;
                  if (!g || parent) return;
                  const shift = dayIndexAt(e, e.currentTarget) - g.offset - Math.max(0, nightsBetween(from, g.booking.checkIn));
                  const checkIn = addDays(g.booking.checkIn, shift);
                  const checkOut = addDays(g.booking.checkOut, shift);
                  if (row.id === g.booking.listingId && shift === 0) return;
                  setMove({ booking: g.booking, target: row, checkIn, checkOut });
                }}
              >
                <div
                  role="rowheader"
                  className={cx(
                    "sticky left-0 z-10 flex shrink-0 items-center gap-2 truncate border-r border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900",
                    row.type === "sub_unit" && "pl-7 text-slate-600 dark:text-slate-300",
                  )}
                  style={{ width: NAME_COL }}
                >
                  <Link href={`/calendar/${row.id}`} className="truncate hover:underline" title={`${row.name} — month view`}>
                    {row.name}
                  </Link>
                  {row.status !== "active" ? <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-500 dark:bg-slate-800">{row.status}</span> : null}
                </div>
                {dates.map((date, i) => {
                  const cell = row.cells[date];
                  const selected =
                    (drag && drag.rowId === row.id && i >= Math.min(drag.a, drag.b) && i <= Math.max(drag.a, drag.b)) ||
                    (!drag && menu?.selection.listingId === row.id && date >= menu.selection.first && date <= menu.selection.last);
                  return (
                    <Cell
                      key={date}
                      cell={cell}
                      parent={parent}
                      width={colW}
                      today={date === today}
                      past={date < today}
                      selected={Boolean(selected)}
                      label={`${row.name}, ${fmtDate.format(d(date))}`}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || (!can.create && !can.block && !can.edit)) return;
                        setMenu(null);
                        setPanel(null);
                        setDrag({ rowId: row.id, a: i, b: i });
                      }}
                      onPointerEnter={() => setDrag((cur) => (cur && cur.rowId === row.id ? { ...cur, b: i } : cur))}
                    />
                  );
                })}
                {rowBookings.map((b) => {
                  const s = nightsBetween(from, b.checkIn);
                  const e = nightsBetween(from, b.checkOut);
                  const left = s < 0 ? 0 : s + 0.5;
                  const right = e > days ? days : e + 0.5;
                  if (right <= left) return null;
                  const movable = can.moveReservations && b.sourceType !== "quote" && Boolean(b.reservationId) && !isChannelSource(b.source ?? "") && b.stayStatus !== "checked_in" && b.stayStatus !== "checked_out";
                  return (
                    <button
                      key={b.holdId}
                      type="button"
                      draggable={movable}
                      onDragStart={(ev) => {
                        const rowEl = ev.currentTarget.parentElement as HTMLElement;
                        grab.current = { booking: b, offset: dayIndexAt(ev, rowEl) - Math.max(0, s) };
                        ev.dataTransfer.effectAllowed = "move";
                        ev.dataTransfer.setData("text/plain", b.holdId);
                      }}
                      onDragEnd={() => (grab.current = null)}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => {
                        setMenu(null);
                        setPanel(b);
                      }}
                      className={cx(
                        "absolute top-1 z-[5] flex h-7 items-center overflow-hidden whitespace-nowrap px-2 text-left text-xs font-medium text-white shadow-sm",
                        s >= 0 ? "rounded-l-full" : "",
                        e <= days ? "rounded-r-full" : "",
                        barColor(b),
                        b.sourceType === "quote" && "bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.25)_0_6px,transparent_6px_12px)]",
                        movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                      )}
                      style={{ left: NAME_COL + left * colW, width: (right - left) * colW - 2 }}
                      title={`${b.guestName ?? (b.sourceType === "quote" ? "Quote hold" : "Booked")} · ${b.checkIn} → ${b.checkOut}${b.code ? ` · ${b.code}` : ""}`}
                      aria-label={`${b.guestName ?? "Booking"} ${b.code ?? ""}, ${b.checkIn} to ${b.checkOut}`}
                    >
                      {b.sourceType === "quote" ? "Quote hold" : (b.guestName ?? "Booked")}
                      {colW * (right - left) > 140 && b.guests ? <span className="ml-1 opacity-80">· {b.guests}</span> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <Legend />

      {menu ? (
        <div className="fixed z-50" style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}>
          <RangeMenu selection={menu.selection} can={can} bookable={menu.bookable} onClose={() => setMenu(null)} />
        </div>
      ) : null}
      {panel ? <BookingPanel booking={panel} row={rowById.get(panel.listingId)} onClose={() => setPanel(null)} /> : null}
      {move ? <MoveDialog move={move} rowById={rowById} seeMoney={can.seeMoney} onClose={() => setMove(null)} /> : null}
    </div>
  );
}

function Cell({
  cell,
  parent,
  width,
  today,
  past,
  selected,
  label,
  onPointerDown,
  onPointerEnter,
}: {
  cell: GridCell | undefined;
  parent: boolean;
  width: number;
  today: boolean;
  past: boolean;
  selected: boolean;
  label: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerEnter: () => void;
}) {
  const blocked = cell?.block || cell?.closed;
  return (
    <div
      role="gridcell"
      aria-label={`${label}${cell ? `: ${cell.status}${cell.price !== null ? `, ${short(cell.price)}` : ""}` : ""}`}
      aria-selected={selected}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cx(
        "relative flex shrink-0 cursor-cell flex-col items-end justify-end border-r border-slate-100 px-1 pb-0.5 text-[10px] leading-tight dark:border-slate-800",
        past && "bg-slate-50 dark:bg-slate-950/40",
        today && "bg-sky-50 dark:bg-sky-950/40",
        cell?.block && "bg-[repeating-linear-gradient(135deg,var(--color-slate-200)_0_4px,transparent_4px_9px)] dark:bg-[repeating-linear-gradient(135deg,var(--color-slate-700)_0_4px,transparent_4px_9px)]",
        !cell?.block && cell?.closed && "bg-slate-200/70 dark:bg-slate-800",
        !blocked && cell?.status === "booked" && cell.reason && !parent && "bg-slate-100 dark:bg-slate-800/60",
        selected && "!bg-sky-200 dark:!bg-sky-800",
      )}
      style={{ width }}
      title={cell?.block ? `Blocked${cell.blockNote ? `: ${cell.blockNote}` : ""}` : cell?.reason ? cell.reason.replace(/_/g, " ") : undefined}
    >
      {cell ? (
        parent ? (
          <span className={cx("mb-auto mt-1 self-center font-medium", cell.unitsAvailable === 0 ? "text-red-600" : "text-slate-600 dark:text-slate-300")}>
            {cell.unitsAvailable ?? 0}/{cell.unitsTotal ?? 0}
          </span>
        ) : null
      ) : null}
      {cell && width >= 48 ? (
        <span className={cx("tabular-nums text-slate-500", cell.priceSource === "override" && "font-semibold text-slate-800 dark:text-slate-100")}>
          {short(cell.price)}
          {cell.minNights > 1 && width >= 60 ? <span className="ml-0.5 text-slate-400">·{cell.minNights}n</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["bg-emerald-600", "Direct / manual"],
    ["bg-blue-700", "Booking.com"],
    ["bg-rose-600", "Airbnb"],
    ["bg-violet-600", "Owner stay"],
    ["bg-amber-600", "Pending approval"],
    ["bg-amber-500", "Quote hold"],
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className={cx("inline-block h-2.5 w-5 rounded-full", c)} /> {l}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 bg-[repeating-linear-gradient(135deg,var(--color-slate-300)_0_3px,transparent_3px_6px)]" /> Blocked
      </span>
      <span>Bold price = override · ·2n = minimum nights · Drag across nights to select · Drag a booking to move it</span>
    </div>
  );
}

function BookingPanel({ booking: b, row, onClose }: { booking: GridBooking; row: GridRow | undefined; onClose: () => void }) {
  return (
    <aside role="dialog" aria-label="Booking" className="fixed inset-y-0 right-0 z-40 w-full max-w-sm overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between">
        <h2 className="text-lg font-semibold">{b.sourceType === "quote" ? "Quote hold" : (b.guestName ?? "Booking")}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-xl text-slate-400 hover:text-slate-700">
          ×
        </button>
      </div>
      <dl className="mt-4 space-y-3 text-sm">
        {b.code ? (
          <div>
            <dt className="text-xs uppercase text-slate-500">Code</dt>
            <dd className="font-mono">{b.code}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs uppercase text-slate-500">Listing</dt>
          <dd>{row?.name}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Dates</dt>
          <dd>
            {fmtDate.format(d(b.checkIn))} → {fmtDate.format(d(b.checkOut))} ({nightsBetween(b.checkIn, b.checkOut)} nights)
          </dd>
        </div>
        {b.status ? (
          <div>
            <dt className="text-xs uppercase text-slate-500">Status</dt>
            <dd>
              {STATUS_LABELS[b.status as ReservationStatus] ?? b.status}
              {b.stayStatus && b.stayStatus !== "upcoming" ? ` · ${b.stayStatus.replace("_", " ")}` : ""}
            </dd>
          </div>
        ) : null}
        {b.source ? (
          <div>
            <dt className="text-xs uppercase text-slate-500">Source</dt>
            <dd>{SOURCE_LABELS[b.source as ReservationSource] ?? b.source}</dd>
          </div>
        ) : null}
        {b.guests ? (
          <div>
            <dt className="text-xs uppercase text-slate-500">Guests</dt>
            <dd>{b.guests}</dd>
          </div>
        ) : null}
        {b.expiresAt ? (
          <div>
            <dt className="text-xs uppercase text-slate-500">Hold expires</dt>
            <dd>{new Date(b.expiresAt).toLocaleString("en-US")}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-6 flex flex-wrap gap-2">
        {b.reservationId ? (
          <Link href={`/reservations/${b.reservationId}`} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900">
            Open reservation
          </Link>
        ) : (
          <Link href="/reservations/quotes" className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Quotes
          </Link>
        )}
        {b.reservationId && !isChannelSource(b.source ?? "") ? (
          <Link href={`/reservations/${b.reservationId}/alter`} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Change dates
          </Link>
        ) : null}
      </div>
    </aside>
  );
}

/** Drag-and-drop relocation: preview (availability + price), then confirm. */
function MoveDialog({ move, rowById, seeMoney, onClose }: { move: NonNullable<Move>; rowById: Map<string, GridRow>; seeMoney: boolean; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<AlterPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const b = move.booking;
  const fromRow = rowById.get(b.listingId);
  const sameDates = move.checkIn === b.checkIn;
  // A booking of a multi-unit moved to a sibling unit on the same dates is a unit reassignment (CAL-11).
  const unitSwap = sameDates && Boolean(fromRow?.parentId) && fromRow?.parentId === move.target.parentId && b.bookedListingId === fromRow?.parentId;
  // Dates moved on the same row: keep what was booked (a multi-unit stays a multi-unit booking).
  const listingId = move.target.id === b.listingId ? (b.bookedListingId ?? b.listingId) : move.target.id;

  useEffect(() => {
    if (unitSwap || !b.reservationId) return;
    let live = true;
    relocateReservation({ reservationId: b.reservationId, listingId, checkIn: move.checkIn, checkOut: move.checkOut, preview: true }).then((r) => {
      if (!live) return;
      if (r?.error) setError(r.error);
      else setPreview(r?.data as AlterPreview);
    });
    return () => {
      live = false;
    };
  }, [unitSwap, b.reservationId, listingId, move.checkIn, move.checkOut]);

  const confirm = () =>
    start(async () => {
      if (!b.reservationId) return;
      const r = unitSwap
        ? await reassignUnit({ reservationId: b.reservationId, unitId: move.target.id })
        : await relocateReservation({ reservationId: b.reservationId, listingId, checkIn: move.checkIn, checkOut: move.checkOut, preview: false });
      if (r?.error) return setError(r.error);
      router.refresh();
      onClose();
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label="Move booking">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Move {b.guestName ?? "booking"}?</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {fromRow?.name} · {fmtDate.format(d(b.checkIn))} → {fmtDate.format(d(b.checkOut))}
          <br />
          to <strong>{move.target.name}</strong> · {fmtDate.format(d(move.checkIn))} → {fmtDate.format(d(move.checkOut))}
        </p>
        <div className="mt-4 space-y-2 text-sm">
          {unitSwap ? <Alert>Same multi-unit and dates: the booking moves to this unit; the price does not change.</Alert> : null}
          {!unitSwap && !preview && !error ? <p className="text-slate-500">Checking availability…</p> : null}
          {preview ? (
            <>
              <Alert tone={preview.available ? "success" : "error"}>{preview.available ? "Available." : preview.availability.message || "Not available."}</Alert>
              {seeMoney ? (
                <p>
                  Total {formatMoney(preview.before.total_cents)} → {formatMoney(preview.after.total_cents)} ({preview.difference_cents >= 0 ? "+" : ""}
                  {formatMoney(preview.difference_cents)})
                </p>
              ) : null}
            </>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={pending || Boolean(error) || (!unitSwap && !preview?.available)} onClick={confirm}>
            {pending ? "Moving…" : "Move"}
          </Button>
        </div>
      </div>
    </div>
  );
}
