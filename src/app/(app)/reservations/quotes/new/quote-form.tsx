"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";

import { createQuote, type GuestHit } from "../../actions";
import { GuestPicker } from "../../_components/guest-picker";
import { StayPreview } from "../../_components/stay-preview";
import type { BookableListing } from "@/lib/reservations/listings";

interface Option {
  key: number;
  listing_id: string;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  pets: number;
}

/** RES-05: up to 10 options (listing + dates) priced now, sent as one link. */
export function QuoteForm({ listings, initial, origin }: { listings: BookableListing[]; initial: Omit<Option, "key">; origin: string }) {
  const [state, action, pending] = useActionState(createQuote, null);
  const [options, setOptions] = useState<Option[]>([{ key: 1, ...initial }]);
  const [guest, setGuest] = useState<GuestHit | null>(null);
  const created = state?.ok ? (state.data as { path: string }) : null;
  const set = (key: number, patch: Partial<Option>) => setOptions((os) => os.map((o) => (o.key === key ? { ...o, ...patch } : o)));

  if (created) {
    const url = `${origin}${created.path}`;
    return (
      <Card title="Quote ready">
        <div className="space-y-3">
          <Alert tone="success">Send this link to the guest. It is shown only now; the PMS stores only a fingerprint of it.</Alert>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Quote link" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="secondary" onClick={() => navigator.clipboard?.writeText(url)}>
              Copy
            </Button>
          </div>
          <Link href="/reservations/quotes" className="text-sm underline">
            Back to quotes
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <form action={action} className="grid gap-6 lg:grid-cols-3">
      <input type="hidden" name="options" value={JSON.stringify(options.map((o) => ({ listing_id: o.listing_id, check_in: o.check_in, check_out: o.check_out, adults: o.adults, children: o.children, pets: o.pets })))} />
      <input type="hidden" name="guest_id" value={guest?.id ?? ""} />
      <div className="space-y-6 lg:col-span-2">
        {options.map((o, i) => (
          <Card key={o.key} title={`Option ${i + 1}`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Listing" htmlFor={`l${o.key}`}>
                  <Select id={`l${o.key}`} value={o.listing_id} onChange={(e) => set(o.key, { listing_id: e.target.value })} required>
                    <option value="">Choose a listing</option>
                    {listings.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.type === "sub_unit" ? `   ${l.parentName ?? ""} › ${l.name}` : l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Check-in" htmlFor={`ci${o.key}`}>
                <Input id={`ci${o.key}`} type="date" value={o.check_in} onChange={(e) => set(o.key, { check_in: e.target.value })} required />
              </Field>
              <Field label="Check-out" htmlFor={`co${o.key}`}>
                <Input id={`co${o.key}`} type="date" value={o.check_out} onChange={(e) => set(o.key, { check_out: e.target.value })} required />
              </Field>
              <div className="grid grid-cols-3 gap-3 sm:col-span-2">
                {(["adults", "children", "pets"] as const).map((k) => (
                  <Field key={k} label={k[0].toUpperCase() + k.slice(1)} htmlFor={`${k}${o.key}`}>
                    <Input id={`${k}${o.key}`} type="number" min={0} max={k === "pets" ? 20 : 100} value={o[k]} onChange={(e) => set(o.key, { [k]: Number(e.target.value) })} />
                  </Field>
                ))}
              </div>
              <div className="sm:col-span-2">
                <StayPreview listingId={o.listing_id} checkIn={o.check_in} checkOut={o.check_out} guests={o.adults + o.children} pets={o.pets} />
              </div>
              {options.length > 1 ? (
                <Button type="button" variant="ghost" onClick={() => setOptions((os) => os.filter((x) => x.key !== o.key))}>
                  Remove option
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
        {options.length < 10 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOptions((os) => [...os, { ...os[os.length - 1], key: Math.max(...os.map((x) => x.key)) + 1, listing_id: "" }])}
          >
            Add another option
          </Button>
        ) : null}
      </div>
      <div className="space-y-4">
        <Card title="Guest">
          <div className="space-y-3">
            <GuestPicker onPick={setGuest} />
            {guest ? null : (
              <>
                <Input name="first_name" placeholder="First name" aria-label="First name" maxLength={100} />
                <Input name="last_name" placeholder="Last name" aria-label="Last name" maxLength={100} />
                <Input name="email" type="email" placeholder="Email" aria-label="Email" maxLength={254} />
              </>
            )}
          </div>
        </Card>
        <Card title="Terms">
          <div className="space-y-3">
            <Field label="Expires in" htmlFor="expires_days">
              <Select id="expires_days" name="expires_days" defaultValue="3">
                {[1, 2, 3, 7, 14, 30].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? "" : "s"}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="hold" className="mt-1" />
              <span>Hold the nights until the quote expires (otherwise availability is checked again when the guest accepts)</span>
            </label>
            <Field label="Message to the guest" htmlFor="message">
              <textarea id="message" name="message" rows={3} maxLength={5000} className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
            </Field>
          </div>
        </Card>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating…" : "Create quote"}
        </Button>
      </div>
    </form>
  );
}
