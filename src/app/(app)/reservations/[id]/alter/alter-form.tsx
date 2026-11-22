"use client";

import { useActionState, useRef, useState } from "react";

import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/properties/money";

import { alterReservation, type AlterPreview } from "../../actions";
import type { BookableListing } from "@/lib/reservations/listings";

interface Current {
  id: string;
  listingId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  currency: string;
  ownerStay: boolean;
}

/** RES-06: change dates, guests or listing; preview the price and availability, then confirm. */
export function AlterForm({ current, listings, canCustomPrice, canSeeMoney }: { current: Current; listings: BookableListing[]; canCustomPrice: boolean; canSeeMoney: boolean }) {
  const [state, action, pending] = useActionState(alterReservation, null);
  const intent = useRef<HTMLInputElement>(null);
  const [pricing, setPricing] = useState("reprice");
  const [dirty, setDirty] = useState(true);
  const preview = state?.ok && state.data && !dirty ? (state.data as AlterPreview) : null;
  const m = (c: number) => formatMoney(c, current.currency);
  const name = (id: string) => listings.find((l) => l.id === id)?.name ?? "this listing";

  return (
    <form
      action={(fd) => {
        setDirty(false);
        action(fd);
      }}
      onChange={() => {
        setDirty(true);
        if (intent.current) intent.current.value = "preview";
      }}
      className="grid gap-6 lg:grid-cols-3"
    >
      <input type="hidden" name="reservationId" value={current.id} />
      <input type="hidden" name="intent" defaultValue="preview" ref={intent} />
      <Card title="New stay" className="lg:col-span-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Listing" htmlFor="listing_id">
              <Select id="listing_id" name="listing_id" defaultValue={current.listingId}>
                {listings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.type === "sub_unit" ? `   ${l.parentName ?? ""} › ${l.name}` : l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Check-in" htmlFor="check_in">
            <Input id="check_in" name="check_in" type="date" defaultValue={current.checkIn} required />
          </Field>
          <Field label="Check-out" htmlFor="check_out">
            <Input id="check_out" name="check_out" type="date" defaultValue={current.checkOut} required />
          </Field>
          <div className="grid grid-cols-4 gap-3 sm:col-span-2">
            {(["adults", "children", "infants", "pets"] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)} htmlFor={k}>
                <Input id={k} name={k} type="number" min={0} max={k === "pets" ? 20 : 100} defaultValue={current[k]} />
              </Field>
            ))}
          </div>
          {current.ownerStay || !canSeeMoney ? (
            <input type="hidden" name="pricing" value="reprice" />
          ) : (
            <div className="space-y-2 sm:col-span-2">
              <p className="text-sm font-medium">Price</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="pricing" value="reprice" checked={pricing === "reprice"} onChange={() => setPricing("reprice")} /> Re-price at today&apos;s rates
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="pricing" value="keep" checked={pricing === "keep"} onChange={() => setPricing("keep")} /> Keep the current total
              </label>
              {canCustomPrice ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="pricing" value="custom" checked={pricing === "custom"} onChange={() => setPricing("custom")} /> Set a new total
                </label>
              ) : null}
              {pricing === "custom" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input name="new_total" inputMode="decimal" placeholder="New total (USD)" aria-label="New total" required />
                  <Input name="reason" placeholder="Reason (required)" aria-label="Reason" required maxLength={1000} />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Preview">
          {preview ? (
            <div className="space-y-3 text-sm">
              <Alert tone={preview.available ? "success" : "error"}>
                {preview.available ? `Available at ${name(preview.after.listing_id)}.` : preview.availability.message || "Not available."}
              </Alert>
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-slate-500">Before</dt>
                <dd className="text-right">
                  {preview.before.check_in} → {preview.before.check_out}
                </dd>
                <dt className="text-slate-500">After</dt>
                <dd className="text-right">
                  {preview.after.check_in} → {preview.after.check_out}
                </dd>
                {canSeeMoney ? (
                  <>
                    <dt className="text-slate-500">Total before</dt>
                    <dd className="text-right tabular-nums">{m(preview.before.total_cents)}</dd>
                    <dt className="text-slate-500">Total after</dt>
                    <dd className="text-right tabular-nums">{m(preview.after.total_cents)}</dd>
                    <dt className="font-medium">Difference</dt>
                    <dd className="text-right font-medium tabular-nums">
                      {preview.difference_cents > 0 ? "+" : ""}
                      {m(preview.difference_cents)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {Object.keys(preview.changes).length === 0 ? <p className="text-slate-500">Nothing changes.</p> : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Preview to see availability and the price difference. Nothing changes until you confirm.</p>
          )}
        </Card>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={pending} onClick={() => intent.current && (intent.current.value = "preview")}>
            Preview
          </Button>
          {preview && preview.available && Object.keys(preview.changes).length > 0 ? (
            <Button type="submit" disabled={pending} onClick={() => intent.current && (intent.current.value = "confirm")}>
              {pending ? "Saving…" : "Confirm change"}
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
