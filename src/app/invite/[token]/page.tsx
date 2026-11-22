import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Alert, Card, Skeleton } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/context";
import { ROLE_LABELS, isRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

import { AcceptInvitationButton } from "./accept-button";

export const metadata: Metadata = { title: "Invitation" };

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-lg font-semibold tracking-tight">PMS</p>
        <Card title="You’re invited">
          <Suspense fallback={<Skeleton lines={3} />}>
            <Invitation params={params} />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}

interface InvitationRow {
  account_name: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
}

async function Invitation({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_invitation", { p_token: token });
  const invitation = (data as InvitationRow[] | null)?.[0];

  if (!invitation) return <Alert tone="error">This invitation link is not valid.</Alert>;
  if (invitation.status !== "pending") {
    return <Alert tone="error">This invitation has {invitation.status === "accepted" ? "already been used" : invitation.status}. Ask your admin for a new one.</Alert>;
  }

  const role = isRole(invitation.role) ? ROLE_LABELS[invitation.role] : invitation.role;
  const ctx = await getAuthContext();
  const here = `/invite/${encodeURIComponent(token)}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Join <strong>{invitation.account_name}</strong> as <strong>{role}</strong>. The invitation is for <strong>{invitation.email}</strong>.
      </p>
      {!ctx ? (
        <div className="flex gap-2">
          <Link className="flex-1 rounded-full bg-brand-600 px-3 py-2 text-center text-sm font-medium text-white" href={`/signup?next=${encodeURIComponent(here)}`}>
            Create account
          </Link>
          <Link className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-center text-sm font-medium dark:border-slate-700" href={`/login?next=${encodeURIComponent(here)}`}>
            Sign in
          </Link>
        </div>
      ) : ctx.user.email?.toLowerCase() !== invitation.email.toLowerCase() ? (
        <Alert tone="error">
          You are signed in as {ctx.user.email}. Sign out and sign in as {invitation.email} to accept.
        </Alert>
      ) : (
        <AcceptInvitationButton token={token} />
      )}
    </div>
  );
}
