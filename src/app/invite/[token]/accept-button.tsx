"use client";

import { useActionState } from "react";

import { Alert, Button } from "@/components/ui";

import { acceptInvitation } from "./actions";

export function AcceptInvitationButton({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitation, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
    </form>
  );
}
