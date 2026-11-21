import type { Metadata } from "next";
import { Suspense } from "react";

import { Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { ROLE_LABELS, isRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

import { revokeInvitation } from "./actions";
import { InviteForm, MemberControls } from "./member-forms";

export const metadata: Metadata = { title: "Team" };

export default function MembersPage() {
  return (
    <>
      <PageHeader title="Team" description="Who can use this account, with which role, and for which listings." />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Members />
      </Suspense>
    </>
  );
}

interface MemberRow {
  id: string;
  role: string;
  status: "active" | "suspended" | "removed";
  listing_scope: "all" | "restricted";
  user_id: string;
  created_at: string;
  profiles: { email: string; full_name: string | null } | null;
  membership_listing_scopes: { kind: "tag" | "listing"; value: string }[];
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

async function Members() {
  const ctx = await requireAuthContext({ permission: "account.manage_users", returnTo: "/settings/members" });
  const supabase = await createClient();
  const accountId = ctx.active.accountId;

  const [{ data: members }, { data: invitations }] = await Promise.all([
    supabase
      .from("memberships")
      .select("id, role, status, listing_scope, user_id, created_at, profiles(email, full_name), membership_listing_scopes(kind, value)")
      .eq("account_id", accountId)
      .neq("status", "removed")
      .order("created_at")
      .returns<MemberRow[]>(),
    supabase
      .from("invitations")
      .select("id, email, role, expires_at, created_at")
      .eq("account_id", accountId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .returns<InvitationRow[]>(),
  ]);

  return (
    <div className="space-y-6">
      <Card title="Invite someone" description="They get a link to create an account or sign in. Links expire after 7 days.">
        <InviteForm />
      </Card>

      {invitations && invitations.length > 0 ? (
        <Card title="Pending invitations">
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>
                  {inv.email} · {isRole(inv.role) ? ROLE_LABELS[inv.role] : inv.role}
                  <span className="ml-2 text-xs text-slate-500">expires {formatDateTime(inv.expires_at)}</span>
                </span>
                <form action={revokeInvitation}>
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <button type="submit" className="text-sm text-red-600 hover:underline">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Members">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(members ?? []).map((m) => (
            <li key={m.id} className="py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.profiles?.full_name ?? m.profiles?.email}</span>
                <span className="text-sm text-slate-500">{m.profiles?.email}</span>
                {m.user_id === ctx.user.id ? <Badge>You</Badge> : null}
                {m.status === "suspended" ? <Badge tone="amber">Suspended</Badge> : null}
                {m.listing_scope === "restricted" ? <Badge tone="amber">Restricted listings</Badge> : null}
              </div>
              <MemberControls
                membership={{
                  id: m.id,
                  role: isRole(m.role) ? m.role : "cleaner",
                  status: m.status,
                  scope: m.listing_scope,
                  tags: m.membership_listing_scopes.filter((s) => s.kind === "tag").map((s) => s.value),
                  listingIds: m.membership_listing_scopes.filter((s) => s.kind === "listing").map((s) => s.value),
                }}
                isSelf={m.user_id === ctx.user.id}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
