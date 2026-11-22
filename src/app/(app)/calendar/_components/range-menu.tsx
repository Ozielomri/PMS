"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert, Button, Input, Select } from "@/components/ui";
import { addDays } from "@/lib/calendar/dates";

import { blockRange, unblockRange, updateRange, type CalendarActionResult } from "../actions";

export interface Selection {
  listingId: string;
  listingName: string;
  /** First and last selected night (inclusive). */
  first: string;
  last: string;
}

export interface MenuPermissions {
  create: boolean;
  block: boolean;
  edit: boolean;
}

const fmt = (d: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

/** What can be done with a selected range of nights on one listing (calendar grid and month view). */
export function RangeMenu({ selection, can, onClose, bookable }: { selection: Selection; can: MenuPermissions; onClose: () => void; bookable: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"menu" | "block" | "edit">("menu");
  const [result, setResult] = useState<CalendarActionResult>(null);
  const [pending, start] = useTransition();
  const from = selection.first;
  const to = addDays(selection.last, 1);
  const nights = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const qs = new URLSearchParams({ listing: selection.listingId, check_in: from, check_out: to }).toString();
  const range = { listingIds: [selection.listingId], from, to };

  const run = (fn: () => Promise<CalendarActionResult>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r?.ok) {
        router.refresh();
        setMode("menu");
      }
    });

  return (
    <div role="dialog" aria-label="Selected dates" className="w-80 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{selection.listingName}</p>
          <p className="text-slate-500">
            {fmt(from)} → {fmt(to)} · {nights} night{nights === 1 ? "" : "s"}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
          ×
        </button>
      </div>

      {mode === "menu" ? (
        <div className="grid gap-2">
          {can.create && bookable ? (
            <>
              <Link className="rounded-md bg-slate-900 px-3 py-2 text-center font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900" href={`/reservations/new?${qs}`}>
                New reservation
              </Link>
              <Link className="rounded-md border border-slate-300 px-3 py-2 text-center hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" href={`/reservations/quotes/new?${qs}`}>
                New quote
              </Link>
              <Link className="rounded-md border border-slate-300 px-3 py-2 text-center hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" href={`/reservations/new?${qs}&kind=owner_stay`}>
                Owner stay
              </Link>
            </>
          ) : null}
          {can.block ? (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" onClick={() => setMode("block")}>
                Block
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => run(() => unblockRange(range))}>
                Unblock
              </Button>
            </div>
          ) : null}
          {can.edit ? (
            <Button type="button" variant="secondary" onClick={() => setMode("edit")}>
              Edit price / min nights
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === "block" ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            run(() => blockRange({ ...range, reason: fd.get("reason") as "maintenance", note: String(fd.get("note") ?? "") }));
          }}
        >
          <Select name="reason" aria-label="Reason" defaultValue="maintenance">
            <option value="maintenance">Maintenance</option>
            <option value="personal_use">Personal use</option>
            <option value="other">Other</option>
          </Select>
          <Input name="note" placeholder="Note (optional)" aria-label="Note" maxLength={500} />
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Blocking…" : "Block nights"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("menu")}>
              Back
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "edit" ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const fields = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
            if (!fields.price_value) delete fields.price_op;
            run(() => updateRange({ ...range, fields, preview: false }));
          }}
        >
          <input type="hidden" name="price_op" value="set" />
          <label className="grid gap-1">
            <span className="text-xs text-slate-500">Nightly price (USD)</span>
            <Input name="price_value" inputMode="decimal" placeholder="Leave empty to keep" />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-slate-500">Minimum nights</span>
            <Input name="min_nights" type="number" min={1} max={365} placeholder="Leave empty to keep" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("menu")}>
              Back
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            More options (percent changes, days of week, several listings) in{" "}
            <Link href={`/calendar/bulk?listing=${selection.listingId}&from=${from}&to=${to}`} className="underline">
              bulk edit
            </Link>
            .
          </p>
        </form>
      ) : null}

      {result?.error ? (
        <div className="mt-3">
          <Alert tone="error">{result.error}</Alert>
        </div>
      ) : null}
      {result?.ok && result.message ? (
        <div className="mt-3">
          <Alert tone="success">{result.message}</Alert>
        </div>
      ) : null}
    </div>
  );
}
