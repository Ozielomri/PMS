"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import type { UpdateResult } from "@/lib/calendar/service";

import { updateRange, type CalendarActionResult } from "../actions";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TRI = [
  ["", "Keep"],
  ["yes", "Yes"],
  ["no", "No"],
] as const;

/** CAL-12 bulk edit: several listings × a date range (optionally some weekdays), preview then apply. */
export function BulkForm({ listings, initial }: { listings: { id: string; name: string; indent: boolean }[]; initial: { listingIds: string[]; from: string; to: string } }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(initial.listingIds));
  const [dow, setDow] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));
  const [priceOp, setPriceOp] = useState("");
  const [result, setResult] = useState<(NonNullable<CalendarActionResult> & { previewed?: boolean }) | null>(null);
  const [pending, start] = useTransition();
  const name = new Map(listings.map((l) => [l.id, l.name]));

  const submit = (form: HTMLFormElement, preview: boolean) => {
    const fd = new FormData(form);
    const fields: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string" && v !== "") fields[k] = v;
    start(async () => {
      const r = await updateRange({ listingIds: [...selected], from: String(fd.get("from")), to: String(fd.get("to")), fields, daysOfWeek: [...dow], preview });
      setResult(r ? { ...r, previewed: preview } : r);
      if (r?.ok && !preview) router.refresh();
    });
  };

  return (
    <form
      className="grid gap-6 lg:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget, true);
      }}
      onChange={() => setResult((r) => (r?.previewed ? null : r))}
    >
      <Card title="Listings" className="lg:col-span-1">
        <div className="mb-2 flex gap-2 text-xs">
          <button type="button" className="underline" onClick={() => setSelected(new Set(listings.map((l) => l.id)))}>
            All
          </button>
          <button type="button" className="underline" onClick={() => setSelected(new Set())}>
            None
          </button>
          <span className="ml-auto text-slate-500">{selected.size} selected</span>
        </div>
        <ul className="max-h-96 space-y-1 overflow-y-auto text-sm">
          {listings.map((l) => (
            <li key={l.id} className={l.indent ? "pl-5" : ""}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(l.id)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(l.id);
                      else n.delete(l.id);
                      return n;
                    })
                  }
                />
                {l.name}
              </label>
            </li>
          ))}
        </ul>
      </Card>
      <div className="space-y-6 lg:col-span-2">
        <Card title="Dates">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From (first night)" htmlFor="from">
              <Input id="from" name="from" type="date" defaultValue={initial.from} required />
            </Field>
            <Field label="To (day after the last night)" htmlFor="to">
              <Input id="to" name="to" type="date" defaultValue={initial.to} required />
            </Field>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">Days of the week</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {DOW.map((d, i) => (
                  <label key={d} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={dow.has(i)}
                      onChange={(e) =>
                        setDow((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(i);
                          else n.delete(i);
                          return n;
                        })
                      }
                    />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Card>
        <Card title="Changes" description="Fields left on Keep are not touched.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price" htmlFor="price_op">
              <Select id="price_op" name="price_op" value={priceOp} onChange={(e) => setPriceOp(e.target.value)}>
                <option value="">Keep</option>
                <option value="set">Set to</option>
                <option value="add">Add / subtract (USD)</option>
                <option value="percent">Change by percent</option>
                <option value="reset">Reset to the listing price</option>
              </Select>
            </Field>
            {priceOp && priceOp !== "reset" ? (
              <Field label={priceOp === "percent" ? "Percent (e.g. 10 or -15)" : priceOp === "add" ? "Amount (e.g. 25 or -25)" : "Nightly price"} htmlFor="price_value">
                <Input id="price_value" name="price_value" inputMode="decimal" required />
              </Field>
            ) : (
              <div />
            )}
            <Field label="Minimum nights" htmlFor="min_nights" hint="Empty = keep">
              <Input id="min_nights" name="min_nights" type="number" min={1} max={365} />
            </Field>
            <Field label="Maximum nights" htmlFor="max_nights" hint="Empty = keep">
              <Input id="max_nights" name="max_nights" type="number" min={1} max={365} />
            </Field>
            {(
              [
                ["closed", "Closed (not bookable)"],
                ["closed_to_arrival", "Closed to arrival"],
                ["closed_to_departure", "Closed to departure"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label} htmlFor={k}>
                <Select id={k} name={k} defaultValue="">
                  {TRI.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        </Card>
        {result?.error ? <Alert tone="error">{result.error}</Alert> : null}
        {result?.ok ? (
          <Card title={result.previewed ? "Preview" : "Done"}>
            <Alert tone="success">{result.message}</Alert>
            <Results results={result.results ?? []} name={name} />
          </Card>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={pending || selected.size === 0}>
            {pending ? "Working…" : "Preview"}
          </Button>
          {result?.ok && result.previewed ? (
            <Button
              type="button"
              disabled={pending}
              onClick={(e) => {
                const form = (e.currentTarget as HTMLButtonElement).form;
                if (form) submit(form, false);
              }}
            >
              Apply
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function Results({ results, name }: { results: UpdateResult[]; name: Map<string, string> }) {
  return (
    <table className="mt-3 w-full text-sm">
      <thead className="text-left text-xs text-slate-500">
        <tr>
          <th className="py-1">Listing</th>
          <th className="py-1 text-right">Nights in range</th>
          <th className="py-1 text-right">Changed</th>
          <th className="py-1 text-right">Skipped</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r) => (
          <tr key={r.listingId}>
            <td className="py-1">{name.get(r.listingId) ?? r.listingId}</td>
            <td className="py-1 text-right tabular-nums">{r.nightsMatched}</td>
            <td className="py-1 text-right tabular-nums">{r.nightsChanged}</td>
            <td className="py-1 text-right tabular-nums">{r.skipped}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
