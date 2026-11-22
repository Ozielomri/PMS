import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";

import { WizardForm } from "./wizard-form";

export const metadata: Metadata = { title: "New listing" };

export default function NewListingPage() {
  return (
    <>
      <PageHeader title="New listing" description="Step 1 of 2: the essentials. Next you add photos and activate — a few minutes in total." />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Wizard />
      </Suspense>
    </>
  );
}

async function Wizard() {
  await requireAuthContext({ permission: "properties.manage", returnTo: "/properties/new" });
  return (
    <Card>
      <WizardForm />
    </Card>
  );
}
