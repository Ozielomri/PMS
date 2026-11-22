"use client";

import { useActionState, useState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { suggestTimezone } from "@/lib/properties/timezone";
import { US_TIMEZONES } from "@/lib/timezones";

import { createListing } from "../actions";

export function WizardForm() {
  const [state, action, pending] = useActionState(createListing, null);
  const [type, setType] = useState<"single" | "multi_parent">("single");
  const [timezone, setTimezone] = useState("America/New_York");
  const [tzTouched, setTzTouched] = useState(false);

  return (
    <form action={action} className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Type</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="type" value="single" checked={type === "single"} onChange={() => setType("single")} /> Single unit (apartment, house)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="type" value="multi_parent" checked={type === "multi_parent"} onChange={() => setType("multi_parent")} /> Multi-unit (identical units, one
            description and price)
          </label>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Internal name" htmlFor="w-name" hint="What your team calls it.">
          <Input id="w-name" name="internal_name" required maxLength={200} placeholder="Ocean Drive 2B" />
        </Field>
        <Field label="Public title" htmlFor="w-title" hint="What guests see (optional now).">
          <Input id="w-title" name="public_title" maxLength={500} placeholder="Sunny 2BR steps from the beach" />
        </Field>
        {type === "multi_parent" ? (
          <Field label="Number of sub-units" htmlFor="w-subs" hint="You can rename, add or remove units later.">
            <Input id="w-subs" name="sub_units" type="number" min={1} max={200} defaultValue={2} required />
          </Field>
        ) : null}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Address</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Street address" htmlFor="w-a1">
            <Input id="w-a1" name="address_line1" required maxLength={200} autoComplete="address-line1" />
          </Field>
          <Field label="Apt, suite (optional)" htmlFor="w-a2">
            <Input id="w-a2" name="address_line2" maxLength={200} autoComplete="address-line2" />
          </Field>
          <Field label="City" htmlFor="w-city">
            <Input id="w-city" name="city" required maxLength={100} autoComplete="address-level2" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="State" htmlFor="w-state">
              <Input
                id="w-state"
                name="state_region"
                maxLength={100}
                autoComplete="address-level1"
                placeholder="FL"
                onChange={(e) => {
                  const tz = suggestTimezone({ countryCode: "US", stateRegion: e.target.value });
                  if (tz && !tzTouched) setTimezone(tz);
                }}
              />
            </Field>
            <Field label="ZIP code" htmlFor="w-zip">
              <Input id="w-zip" name="postal_code" required maxLength={20} autoComplete="postal-code" inputMode="numeric" />
            </Field>
          </div>
          <input type="hidden" name="country_code" value="US" />
          <Field label="Timezone" htmlFor="w-tz" hint="Suggested from the state; all calendar dates use this timezone.">
            <Select
              id="w-tz"
              name="timezone"
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                setTzTouched(true);
              }}
            >
              {US_TIMEZONES.some((t) => t.value === timezone) ? null : <option value={timezone}>{timezone}</option>}
              {US_TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Capacity {type === "multi_parent" ? "(per unit)" : ""}</legend>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Max guests" htmlFor="w-guests">
            <Input id="w-guests" name="max_guests" type="number" min={1} max={100} required defaultValue={2} />
          </Field>
          <Field label="Bedrooms" htmlFor="w-bed" hint="0 for a studio">
            <Input id="w-bed" name="bedrooms" type="number" min={0} max={100} required defaultValue={1} />
          </Field>
          <Field label="Bathrooms" htmlFor="w-bath">
            <Input id="w-bath" name="bathrooms_full" type="number" min={0} max={100} required defaultValue={1} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Price and times</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Base nightly price (USD)" htmlFor="w-price">
            <Input id="w-price" name="base_price_cents" required inputMode="decimal" placeholder="150" />
          </Field>
          <Field label="Check-in from" htmlFor="w-in">
            <Input id="w-in" name="check_in_from" type="time" required defaultValue="16:00" />
          </Field>
          <Field label="Check-out by" htmlFor="w-out">
            <Input id="w-out" name="check_out_by" type="time" required defaultValue="11:00" />
          </Field>
        </div>
      </fieldset>

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Continue to photos"}
      </Button>
    </form>
  );
}
