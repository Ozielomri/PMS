import type { Metadata } from "next";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Card, Input, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { MANUAL_SOURCES, SOURCE_LABELS, type ReservationSource } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { saveApprovalHours } from "../../reservations/actions";

export const metadata: Metadata = { title: "Reservation settings" };

export default function ReservationSettingsPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <ReservationSettings />
    </Suspense>
  );
}

/** RES-04: how long a request (pending approval) holds the nights, per source. */
async function ReservationSettings() {
  const ctx = await requireAuthContext({ permission: "reservations.manage", returnTo: "/settings/reservations" });
  const supabase = await createClient();
  const { data } = await supabase
    .from("reservation_source_settings")
    .select("source, approval_hours")
    .eq("account_id", ctx.active.accountId)
    .returns<{ source: string; approval_hours: number }[]>();
  const hours = new Map((data ?? []).map((r) => [r.source, r.approval_hours]));
  const sources: ReservationSource[] = [...MANUAL_SOURCES, "booking_com", "airbnb", "vrbo"];
  return (
    <>
      <PageHeader title="Reservation settings" />
      <Card title="Approval window" description="A request that nobody approves within this many hours expires and frees the nights. Channel requests follow the channel's own deadline when it sends one.">
        <ActionForm action={saveApprovalHours} fields={{}} label="Save" variant="primary" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((s) => (
              <label key={s} className="flex items-center justify-between gap-3 text-sm">
                <span>{SOURCE_LABELS[s]}</span>
                <span className="flex items-center gap-1">
                  <Input name={`hours_${s}`} type="number" min={1} max={168} defaultValue={hours.get(s) ?? 24} className="w-20" aria-label={`${SOURCE_LABELS[s]} approval hours`} />
                  <span className="text-slate-500">h</span>
                </span>
              </label>
            ))}
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
