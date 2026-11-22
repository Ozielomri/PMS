"use client";

import { useActionState, useState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { HUMAN_ROLES, ROLE_LABELS, type Role } from "@/lib/auth/permissions";

import { inviteMember, setListingScope, updateMember } from "./actions";

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteMember, null);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
        <Field label="Email" htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" required />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select id="invite-role" name="role" defaultValue="manager">
            {HUMAN_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Create invite"}
        </Button>
      </div>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.inviteUrl ? (
        <Alert tone="success">
          Invitation created. Send this link to them (it is shown only once):
          <code className="mt-1 block break-all text-xs">{state.inviteUrl}</code>
        </Alert>
      ) : null}
    </form>
  );
}

interface MembershipView {
  id: string;
  role: Role;
  status: "active" | "suspended" | "removed";
  scope: "all" | "restricted";
  tags: string[];
  listingIds: string[];
}

export function MemberControls({ membership, isSelf }: { membership: MembershipView; isSelf: boolean }) {
  const [state, action, pending] = useActionState(updateMember, null);
  const [scopeState, scopeAction, scopePending] = useActionState(setListingScope, null);
  const [scope, setScope] = useState(membership.scope);

  return (
    <div className="mt-3 space-y-3">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="membershipId" value={membership.id} />
        <label className="sr-only" htmlFor={`role-${membership.id}`}>
          Role
        </label>
        <Select id={`role-${membership.id}`} name="role" defaultValue={membership.role} className="w-auto">
          {HUMAN_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" disabled={pending}>
          Save role
        </Button>
        {membership.status === "active" ? (
          <Button type="submit" name="status" value="suspended" variant="ghost" disabled={pending || isSelf}>
            Suspend
          </Button>
        ) : (
          <Button type="submit" name="status" value="active" variant="ghost" disabled={pending}>
            Reactivate
          </Button>
        )}
        <Button type="submit" name="status" value="removed" variant="ghost" className="text-red-600" disabled={pending || isSelf}>
          Remove
        </Button>
      </form>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}

      {membership.role !== "admin" ? (
        <details className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
          <summary className="cursor-pointer font-medium">
            Listing access: {membership.scope === "all" ? "all listings" : `${membership.tags.length} tags, ${membership.listingIds.length} listings`}
          </summary>
          <form action={scopeAction} className="mt-3 space-y-3">
            <input type="hidden" name="membershipId" value={membership.id} />
            <fieldset className="flex gap-4">
              <legend className="sr-only">Listing access</legend>
              {(["all", "restricted"] as const).map((s) => (
                <label key={s} className="flex items-center gap-2">
                  <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
                  {s === "all" ? "All listings" : "Only selected tags or listings"}
                </label>
              ))}
            </fieldset>
            {scope === "restricted" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Tags" htmlFor={`tags-${membership.id}`} hint="Comma-separated, e.g. Amsterdam, Owner: Jansen">
                  <Input id={`tags-${membership.id}`} name="tags" defaultValue={membership.tags.join(", ")} />
                </Field>
                <Field label="Listing IDs" htmlFor={`listings-${membership.id}`} hint="Listing picker arrives with Properties (step 3).">
                  <Input id={`listings-${membership.id}`} name="listingIds" defaultValue={membership.listingIds.join(", ")} />
                </Field>
              </div>
            ) : null}
            <Button type="submit" variant="secondary" disabled={scopePending}>
              Save listing access
            </Button>
            {scopeState?.error ? <Alert tone="error">{scopeState.error}</Alert> : null}
            {scopeState?.ok ? <Alert tone="success">Saved.</Alert> : null}
          </form>
        </details>
      ) : null}
    </div>
  );
}
