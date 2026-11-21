import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, Skeleton } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/context";
import { redirect } from "next/navigation";

import { MfaClient } from "./mfa-client";

export const metadata: Metadata = { title: "Two-factor authentication" };

export default function MfaPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-lg font-semibold tracking-tight">PMS</p>
        <Card title="Two-factor authentication">
          <Suspense fallback={<Skeleton lines={4} />}>
            <MfaGate />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}

async function MfaGate() {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login?next=/mfa");
  const isAdmin = ctx.memberships.some((m) => m.role === "admin");
  return <MfaClient required={isAdmin} alreadyVerified={ctx.aal === "aal2"} />;
}
