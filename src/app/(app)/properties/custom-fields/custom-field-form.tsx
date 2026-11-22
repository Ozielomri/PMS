"use client";

import { useActionState, useState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, type CustomFieldType } from "@/lib/properties/constants";

import { createCustomField } from "../actions";

const toKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 50);

export function CustomFieldForm() {
  const [state, action, pending] = useActionState(createCustomField, null);
  const [type, setType] = useState<CustomFieldType>("text");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Label" htmlFor="cf-label">
          <Input
            id="cf-label"
            name="label"
            required
            maxLength={100}
            value={label}
            placeholder="Door code"
            onChange={(e) => {
              setLabel(e.target.value);
              if (!keyTouched) setKey(toKey(e.target.value));
            }}
          />
        </Field>
        <Field label="Key" htmlFor="cf-key" hint="Used as {{custom.key}}; cannot change later.">
          <Input
            id="cf-key"
            name="key"
            required
            pattern="[a-z][a-z0-9_]{0,49}"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyTouched(true);
            }}
          />
        </Field>
        <Field label="Type" htmlFor="cf-type">
          <Select id="cf-type" name="field_type" value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {CUSTOM_FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {type === "dropdown" ? (
        <Field label="Options" htmlFor="cf-options" hint="One per line">
          <textarea id="cf-options" name="options" rows={3} required className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
        </Field>
      ) : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add field"}
      </Button>
    </form>
  );
}
