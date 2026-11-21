"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { Alert, Button, Field, Input } from "@/components/ui";

import { signUp } from "../actions";

const PASSWORD_MIN_LENGTH = 12;

export function SignupForm() {
  const next = useSearchParams().get("next") ?? "";
  const [state, action, pending] = useActionState(signUp, null);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Full name" htmlFor="fullName">
        <Input id="fullName" name="fullName" autoComplete="name" required />
      </Field>
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
      </Field>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.message ? <Alert tone="success">{state.message}</Alert> : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link className="font-medium text-slate-900 underline dark:text-slate-100" href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
