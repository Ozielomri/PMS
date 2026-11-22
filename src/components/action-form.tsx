"use client";

import { useActionState, type ReactNode } from "react";

import { Alert, Button } from "@/components/ui";

type Result = { ok?: boolean; error?: string; message?: string } | null;

/** A one-button form for a server action, with optional confirmation and inline result. */
export function ActionForm({
  action,
  fields,
  label,
  pendingLabel,
  confirm,
  variant = "secondary",
  children,
  className,
}: {
  action: (prev: Result, formData: FormData) => Promise<Result>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  children?: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? (pendingLabel ?? "Working…") : label}
      </Button>
      {state?.error ? (
        <div className="mt-2">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state?.ok && state.message ? (
        <div className="mt-2">
          <Alert tone="success">{state.message}</Alert>
        </div>
      ) : null}
    </form>
  );
}
