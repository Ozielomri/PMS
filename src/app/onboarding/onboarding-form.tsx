"use client";

import { useActionState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { US_TIMEZONES } from "@/lib/timezones";

import { createAccount } from "./actions";

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createAccount, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Company name" htmlFor="name">
        <Input id="name" name="name" required maxLength={200} placeholder="Harbor View Rentals" />
      </Field>
      <Field label="Time zone" htmlFor="timezone" hint="Default for new listings. Each listing can have its own.">
        <Select id="timezone" name="timezone" defaultValue="America/New_York">
          {US_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </Select>
      </Field>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}
