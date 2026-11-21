import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Card, Skeleton } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/context";

import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your account" };

export default function OnboardingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-lg font-semibold tracking-tight">PMS</p>
        <Card
          title="Set up your company"
          description="This creates your operator account. You become its admin and will turn on two-factor authentication next."
        >
          <Suspense fallback={<Skeleton lines={3} />}>
            <OnboardingGate />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}

async function OnboardingGate() {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login?next=/onboarding");
  if (ctx.active) redirect("/dashboard");
  return <OnboardingForm />;
}
