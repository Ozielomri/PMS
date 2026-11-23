import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { describeAction, describeConditions, describeTiming, STARTERS, TRIGGER_LABELS, type RuleAction, type RuleConditions, type Trigger } from "@/lib/automations/rules";
import { createClient } from "@/lib/supabase/server";

import { addStarter } from "./actions";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Automations />
    </Suspense>
  );
}

interface RuleRow {
  id: string;
  name: string;
  status: "active" | "paused";
  trigger: Trigger;
  offset_minutes: number;
  at_time: string | null;
  conditions: RuleConditions;
  action: RuleAction;
  starter_key: string | null;
}

async function Automations() {
  const ctx = await requireAuthContext({ permission: "automations.view", returnTo: "/automations" });
  const supabase = await createClient();
  const accountId = ctx.active.accountId;
  const [{ data: rules }, { data: scheduled }, { data: recent }, { data: listings }] = await Promise.all([
    supabase.from("automation_rules").select("id, name, status, trigger, offset_minutes, at_time, conditions, action, starter_key").eq("account_id", accountId).is("deleted_at", null).order("created_at").returns<RuleRow[]>(),
    supabase.from("automation_jobs").select("rule_id").eq("account_id", accountId).eq("status", "scheduled").limit(10000).returns<{ rule_id: string }[]>(),
    supabase.from("automation_jobs").select("rule_id, executed_at, status").eq("account_id", accountId).not("executed_at", "is", null).order("executed_at", { ascending: false }).limit(500).returns<{ rule_id: string; executed_at: string; status: string }[]>(),
    supabase.from("listings").select("id, internal_name").eq("account_id", accountId).returns<{ id: string; internal_name: string }[]>(),
  ]);
  const counts = new Map<string, number>();
  for (const j of scheduled ?? []) counts.set(j.rule_id, (counts.get(j.rule_id) ?? 0) + 1);
  const lastRun = new Map<string, { at: string; status: string }>();
  for (const j of recent ?? []) if (!lastRun.has(j.rule_id)) lastRun.set(j.rule_id, { at: j.executed_at, status: j.status });
  const names = new Map((listings ?? []).map((l) => [l.id, l.internal_name]));
  const canEdit = ctx.can("automations.edit");
  const used = new Set((rules ?? []).map((r) => r.starter_key).filter(Boolean));
  const starters = STARTERS.filter((s) => !used.has(s.key));

  return (
    <>
      <PageHeader
        title="Automations"
        description="Messages that go out by themselves at the right moment of every stay, and move with the booking when dates change."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/automations/log" className="inline-flex min-h-10 items-center rounded-full border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              Execution log
            </Link>
            {canEdit ? (
              <Link href="/automations/new" className="inline-flex min-h-10 items-center rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                New rule
              </Link>
            ) : null}
          </div>
        }
      />

      {(rules ?? []).length === 0 ? (
        <Card className="mb-6">
          <p className="text-sm text-slate-600 dark:text-slate-300">No rules yet. Start from one of the common ones below, or build your own.</p>
        </Card>
      ) : (
        <div className="mb-8 grid gap-4">
          {(rules ?? []).map((r) => {
            const last = lastRun.get(r.id);
            return (
              <Link
                key={r.id}
                href={`/automations/${r.id}`}
                className="grid gap-3 rounded-[22px] border border-slate-200 bg-white p-5 transition hover:border-slate-300 sm:grid-cols-[1.4fr_1fr_auto] sm:items-center dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-xl">{r.name}</span>
                    <Badge tone={r.status === "active" ? "green" : "neutral"}>{r.status === "active" ? "Active" : "Paused"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {describeTiming(r)} · {describeAction(r.action)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {TRIGGER_LABELS[r.trigger]} · {describeConditions(r.conditions, names)}
                  </p>
                </div>
                <div className="text-sm">
                  <p>
                    <span className="font-display text-2xl tabular-nums">{counts.get(r.id) ?? 0}</span> <span className="text-slate-500">scheduled</span>
                  </p>
                  <p className="text-xs text-slate-500">{last ? `Last run ${formatDateTime(last.at)} · ${last.status}` : "Not run yet"}</p>
                </div>
                <span aria-hidden className="hidden text-slate-400 sm:block">
                  →
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {canEdit && starters.length ? (
        <section aria-labelledby="starters">
          <h2 id="starters" className="mb-1 font-display text-2xl">
            Common rules
          </h2>
          <p className="mb-4 text-sm text-slate-500">Turn one on in a click; you can edit the wording afterwards.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {starters.map((s) => (
              <Card key={s.key}>
                <p className="font-display text-lg">{s.title}</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{s.summary}</p>
                <ActionForm action={addStarter} fields={{ key: s.key }} label="Turn on" variant="secondary" className="mt-4" />
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
