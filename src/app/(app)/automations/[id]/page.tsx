import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import type { RulePayload } from "@/lib/automations/rules";
import { createClient } from "@/lib/supabase/server";

import { deleteRule, duplicateRule, setRuleStatus } from "../actions";
import { builderData } from "../_components/builder-data";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from "../_components/job-status";
import { RuleBuilder } from "../_components/rule-builder";

export const metadata: Metadata = { title: "Automation" };

export default function AutomationPage({ params, searchParams }: PageProps<"/automations/[id]">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Automation params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Automation({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const ctx = await requireAuthContext({ permission: "automations.view", returnTo: `/automations/${id}` });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const created = (await searchParams).created === "1";
  const supabase = await createClient();
  const { data: rule } = await supabase.from("automation_rules").select("*").eq("id", id).is("deleted_at", null).maybeSingle<RulePayload & { id: string; account_id: string }>();
  if (!rule) notFound();
  const [{ listings, samples }, { data: jobs }, { data: history }] = await Promise.all([
    builderData(supabase, ctx.active.accountId),
    supabase
      .from("automation_jobs")
      .select("id, status, run_at, executed_at, reason, reservation:reservations(id, code, guest:guests(first_name, last_name))")
      .eq("rule_id", id)
      .order("run_at", { ascending: true })
      .limit(50)
      .returns<{ id: string; status: string; run_at: string; executed_at: string | null; reason: string | null; reservation: { id: string; code: string; guest: { first_name: string; last_name: string | null } | null } | null }[]>(),
    ctx.can("audit.view")
      ? supabase.from("audit_log").select("id, action, occurred_at, actor_type, diff").eq("entity_type", "automation_rules").eq("entity_id", id).order("id", { ascending: false }).limit(20).returns<{ id: number; action: string; occurred_at: string; actor_type: string; diff: Record<string, unknown> | null }[]>()
      : Promise.resolve({ data: null }),
  ]);
  const canEdit = ctx.can("automations.edit");

  return (
    <>
      <PageHeader
        title={rule.name}
        description="Edits apply to runs that have not happened yet; sent messages stay as they were."
        actions={
          canEdit ? (
            <div className="flex flex-wrap items-start gap-2">
              <ActionForm action={setRuleStatus} fields={{ ruleId: id, status: rule.status === "active" ? "paused" : "active" }} label={rule.status === "active" ? "Pause" : "Resume"} variant="secondary" />
              <ActionForm action={duplicateRule} fields={{ ruleId: id }} label="Duplicate" variant="secondary" />
              {ctx.can("automations.manage") ? <ActionForm action={deleteRule} fields={{ ruleId: id }} label="Delete" variant="ghost" confirm="Delete this rule? Its pending runs are canceled; sent messages stay." /> : null}
            </div>
          ) : undefined
        }
      />
      {created ? (
        <div className="mb-6">
          <Alert tone="success">Rule created. Matching reservations are scheduled below.</Alert>
        </div>
      ) : null}
      <RuleBuilder ruleId={id} initial={rule} listings={listings} samples={samples} canEdit={canEdit} />

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card title="Runs" description="Upcoming and past runs of this rule (first 50).">
          {(jobs ?? []).length === 0 ? <p className="text-sm text-slate-500">No runs yet.</p> : null}
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {(jobs ?? []).map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {j.reservation ? (
                    <Link href={`/reservations/${j.reservation.id}?tab=automations`} className="font-mono hover:underline">
                      {j.reservation.code}
                    </Link>
                  ) : null}{" "}
                  · {[j.reservation?.guest?.first_name, j.reservation?.guest?.last_name].filter(Boolean).join(" ")}
                  {j.reason ? <span className="block text-xs text-slate-500">{j.reason}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{formatDateTime(j.executed_at ?? j.run_at)}</span>
                  <Badge tone={JOB_STATUS_TONE[j.status] ?? "neutral"}>{JOB_STATUS_LABEL[j.status] ?? j.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {history ? (
          <Card title="Change history" description="Who changed this rule, and when.">
            <ul className="space-y-2 text-sm">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="font-medium">{h.action === "insert" ? "Created" : "Changed"}</span>
                  {h.action === "update" && h.diff ? (
                    <span className="text-slate-500"> · {Object.keys(h.diff).filter((k) => k !== "updated_at").join(", ").replace(/_/g, " ")}</span>
                  ) : null}
                  <span className="block text-xs text-slate-500">
                    {formatDateTime(h.occurred_at)} · {h.actor_type}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
