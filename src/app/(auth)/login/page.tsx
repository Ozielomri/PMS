import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, Skeleton } from "@/components/ui";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Card title="Sign in" description="Use your password or get a one-time link by email.">
      <Suspense fallback={<Skeleton lines={4} />}>
        <LoginForm />
      </Suspense>
    </Card>
  );
}
