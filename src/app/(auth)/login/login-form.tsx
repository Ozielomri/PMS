"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState, useState } from "react";

import { Alert, Button, Field, Input, cx } from "@/components/ui";

import { sendMagicLink, signInWithPassword } from "../actions";

export function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "";
  const linkError = params.get("error");
  const [mode, setMode] = useState<"password" | "link">("password");
  const [passwordState, passwordAction, passwordPending] = useActionState(signInWithPassword, null);
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, null);

  return (
    <div className="space-y-4">
      {linkError ? <Alert tone="error">That link is invalid or has expired. Request a new one.</Alert> : null}

      <div role="tablist" aria-label="Sign-in method" className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm dark:bg-slate-800">
        {(["password", "link"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx("rounded px-3 py-1.5", mode === m ? "bg-white font-medium shadow-sm dark:bg-slate-900" : "text-slate-500")}
          >
            {m === "password" ? "Password" : "Email link"}
          </button>
        ))}
      </div>

      {mode === "password" ? (
        <form action={passwordAction} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
          {passwordState?.error ? <Alert tone="error">{passwordState.error}</Alert> : null}
          <Button type="submit" className="w-full" disabled={passwordPending}>
            {passwordPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      ) : (
        <form action={linkAction} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <Field label="Email" htmlFor="link-email">
            <Input id="link-email" name="email" type="email" autoComplete="email" required />
          </Field>
          {linkState?.error ? <Alert tone="error">{linkState.error}</Alert> : null}
          {linkState?.message ? <Alert tone="success">{linkState.message}</Alert> : null}
          <Button type="submit" className="w-full" disabled={linkPending}>
            {linkPending ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}

      <p className="text-center text-sm text-slate-500">
        New here?{" "}
        <Link className="font-medium text-slate-900 underline dark:text-slate-100" href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}>
          Create an account
        </Link>
      </p>
    </div>
  );
}
