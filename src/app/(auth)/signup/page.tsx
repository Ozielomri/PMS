import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, Skeleton } from "@/components/ui";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <Card title="Create your account" description="You can set up your company account or join one you were invited to.">
      <Suspense fallback={<Skeleton lines={5} />}>
        <SignupForm />
      </Suspense>
    </Card>
  );
}
