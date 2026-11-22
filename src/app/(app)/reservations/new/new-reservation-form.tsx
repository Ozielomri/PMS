"use client";

import { useActionState, useState } from "react";

import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import type { BookableListing } from "@/lib/reservations/listings";
import { MANUAL_SOURCES, SOURCE_LABELS } from "@/lib/reservations/status";

import { createReservation, type GuestHit } from "../actions";
import { GuestPicker } from "../_components/guest-picker";
import { StayPreview } from "../_components/stay-preview";

export type { BookableListing };

export function NewReservationForm({
  listings,
  initial,
  canOverride,
  canSeeMoney,
}: {
  listings: BookableListing[];
  initial: { listingId: string; checkIn: string; checkOut: string; kind: "guest" | "owner_stay" };
  canOverride: boolean;
  canSeeMoney: boolean;
}) {
  const [state, action, pending] = useActionState(createReservation, null);
  const [listingId, setListingId] = useState(initial.listingId);
  const [checkIn, setCheckIn] = useState(initial.checkIn);
  const [checkOut, setCheckOut] = useState(initial.checkOut);
  const [kind, setKind] = useState(initial.kind);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [pets, setPets] = useState(0);
  const [guest, setGuest] = useState<GuestHit | null>(null);
  const [override, setOverride] = useState(false);
  const owner = kind === "owner_stay";

  return (
    <form action={action} className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Stay">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Type" htmlFor="kind">
                <Select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="guest">Guest reservation</option>
                  <option value="owner_stay">Owner stay (blocks the dates, no price)</option>
                </Select>
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Listing" htmlFor="listing_id" hint="Booking a multi-unit picks a free unit automatically.">
                <Select id="listing_id" name="listing_id" value={listingId} onChange={(e) => setListingId(e.target.value)} required>
                  <option value="">Choose a listing</option>
                  {listings.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.type === "sub_unit" ? `   ${l.parentName ?? ""} › ${l.name}` : l.type === "multi_parent" ? `${l.name} (any unit)` : l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Check-in" htmlFor="check_in">
              <Input id="check_in" name="check_in" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
            </Field>
            <Field label="Check-out" htmlFor="check_out">
              <Input id="check_out" name="check_out" type="date" value={checkOut} min={checkIn || undefined} onChange={(e) => setCheckOut(e.target.value)} required />
            </Field>
            <div className="grid grid-cols-4 gap-3 sm:col-span-2">
              <Field label="Adults" htmlFor="adults">
                <Input id="adults" name="adults" type="number" min={0} max={100} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
              </Field>
              <Field label="Children" htmlFor="children">
                <Input id="children" name="children" type="number" min={0} max={100} value={children} onChange={(e) => setChildren(Number(e.target.value))} />
              </Field>
              <Field label="Infants" htmlFor="infants">
                <Input id="infants" name="infants" type="number" min={0} max={100} defaultValue={0} />
              </Field>
              <Field label="Pets" htmlFor="pets">
                <Input id="pets" name="pets" type="number" min={0} max={20} value={pets} onChange={(e) => setPets(Number(e.target.value))} />
              </Field>
            </div>
            <Field label="Expected arrival" htmlFor="eta">
              <Input id="eta" name="eta" type="time" />
            </Field>
            <Field label="Expected departure" htmlFor="etd">
              <Input id="etd" name="etd" type="time" />
            </Field>
          </div>
        </Card>

        {owner ? null : (
          <Card title="Guest">
            <input type="hidden" name="guest_id" value={guest?.id ?? ""} />
            <div className="space-y-4">
              <GuestPicker onPick={setGuest} />
              {guest ? null : (
                <>
                  <p className="text-sm text-slate-500">Or enter a new guest:</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="First name" htmlFor="first_name">
                      <Input id="first_name" name="first_name" maxLength={100} />
                    </Field>
                    <Field label="Last name" htmlFor="last_name">
                      <Input id="last_name" name="last_name" maxLength={100} />
                    </Field>
                    <Field label="Email" htmlFor="email">
                      <Input id="email" name="email" type="email" maxLength={254} />
                    </Field>
                    <Field label="Phone" htmlFor="phone">
                      <Input id="phone" name="phone" type="tel" maxLength={40} />
                    </Field>
                  </div>
                </>
              )}
            </div>
          </Card>
        )}

        <Card title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            {owner ? null : (
              <>
                <Field label="Status" htmlFor="status" hint="Pending approval holds the nights until the approval deadline.">
                  <Select id="status" name="status" defaultValue="confirmed">
                    <option value="confirmed">Confirmed</option>
                    <option value="reserved">Pending approval (request)</option>
                    <option value="inquiry">Inquiry (does not hold the nights)</option>
                  </Select>
                </Field>
                <Field label="Source" htmlFor="source">
                  <Select id="source" name="source" defaultValue="direct">
                    {MANUAL_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <div className="sm:col-span-2">
              <Field label="Tags" htmlFor="tags" hint="Comma separated">
                <Input id="tags" name="tags" maxLength={500} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Internal note" htmlFor="note">
                <textarea
                  id="note"
                  name="note"
                  rows={3}
                  maxLength={10000}
                  className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </Field>
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card title={owner ? "Availability" : "Price"}>
          <StayPreview listingId={listingId} checkIn={checkIn} checkOut={checkOut} guests={adults + children} pets={pets} showPrice={!owner && canSeeMoney} />
          {!owner && canOverride ? (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override the total
              </label>
              {override ? (
                <>
                  <Field label="New total (USD)" htmlFor="price_override">
                    <Input id="price_override" name="price_override" inputMode="decimal" placeholder="1200.00" required />
                  </Field>
                  <Field label="Reason" htmlFor="override_reason">
                    <Input id="override_reason" name="override_reason" maxLength={1000} required />
                  </Field>
                </>
              ) : null}
            </div>
          ) : null}
        </Card>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating…" : owner ? "Create owner stay" : "Create reservation"}
        </Button>
      </div>
    </form>
  );
}
