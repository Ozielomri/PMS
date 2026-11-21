"use client";

import { useActionState } from "react";

import { Alert, Button, Field, Input } from "@/components/ui";
import { ALL_EVENT_TYPES, EVENT_TYPES } from "@/lib/events/catalog";

import { createEndpoint, rotateSecret } from "./actions";

const GROUPS = ["*", ...new Set(ALL_EVENT_TYPES.map((t) => `${t.split(".")[0]}.*`))];

function SecretOnce({ secret }: { secret: string }) {
  return (
    <Alert tone="success">
      Signing secret (shown only once — store it now):
      <code className="mt-1 block break-all text-xs">{secret}</code>
    </Alert>
  );
}

export function CreateEndpointForm() {
  const [state, action, pending] = useActionState(createEndpoint, null);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="URL" htmlFor="wh-url" hint="Must be a public https:// address.">
          <Input id="wh-url" name="url" type="url" placeholder="https://example.com/pms-webhooks" required />
        </Field>
        <Field label="Description" htmlFor="wh-desc">
          <Input id="wh-desc" name="description" maxLength={500} placeholder="Accounting sync" />
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">Events</legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {GROUPS.map((g) => (
            <label key={g} className="flex items-center gap-2">
              <input type="checkbox" name="eventTypes" value={g} defaultChecked={g === "*"} />
              <code className="text-xs">{g === "*" ? "* (all events)" : g}</code>
            </label>
          ))}
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-500">Individual event types</summary>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {ALL_EVENT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input type="checkbox" name="eventTypes" value={t} />
                <code className="text-xs">{t}</code>
                {EVENT_TYPES[t].planned ? <span className="text-xs text-slate-400">(coming)</span> : null}
              </label>
            ))}
          </div>
        </details>
      </fieldset>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.secret ? <SecretOnce secret={state.secret} /> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add endpoint"}
      </Button>
    </form>
  );
}

export function RotateSecretButton({ endpointId }: { endpointId: string }) {
  const [state, action, pending] = useActionState(rotateSecret, null);
  return (
    <form action={action} className="max-w-xs">
      <input type="hidden" name="endpointId" value={endpointId} />
      <button type="submit" className="text-sm underline-offset-2 hover:underline" disabled={pending}>
        Rotate secret
      </button>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.secret ? <SecretOnce secret={state.secret} /> : null}
    </form>
  );
}
