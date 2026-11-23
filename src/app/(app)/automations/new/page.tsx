import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { STARTERS, type RulePayload } from "@/lib/automations/rules";
import { createClient } from "@/lib/supabase/server";

import { builderData } from "../_components/builder-data";
import { RuleBuilder } from "../_components/rule-builder";

export const metadata: Metadata = { title: "New automation" };

export default function NewAutomationPage({ searchParams }: PageProps<"/automations/new">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <NewAutomation searchParams={searchParams} />
    </Suspense>
  );
}

const BLANK: RulePayload = {
  name: "",
  status: "active",
  trigger: "check_in",
  offset_minutes: -1440,
  at_time: "10:00",
  conditions: {},
  expire_after_hours: 12,
  action: { kind: "message", recipient: "guest", subject: "", body: "Hi {{guest.first_name}},\n\n" },
};

async function NewAutomation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "automations.edit", returnTo: "/automations/new" });
  const key = (await searchParams).starter;
  const starter = STARTERS.find((s) => s.key === key);
  const { listings, samples } = await builderData(await createClient(), ctx.active.accountId);
  return (
    <>
      <PageHeader title="New automation" description="When something happens to a booking, do something — for every matching reservation." />
      <RuleBuilder ruleId={null} initial={starter ? { ...starter.payload, status: "active", starter_key: starter.key } : BLANK} listings={listings} samples={samples} canEdit />
    </>
  );
}
