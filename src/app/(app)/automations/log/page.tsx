import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Button, Card, Input, PageHeader, Select, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { isIsoDate } from "@/lib/calendar/dates";
import { createClient } from "@/lib/supabase/server";

import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from "../_components/job-status";

export const metadata: Metadata = { title: "Automation log" };

export default function AutomationLogPage({ searchParams }: PageProps<"/automations/log">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <AutomationLog searchParams={searchParams} />
    </Suspense>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** AUT-13: every run across rules, for troubleshooting. */
async function AutomationLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "automations.view", returnTo: "/automations/log" });
  const sp = await searchParams;
  const rule = /^[0-9a-f-]{36}$/i.test(str(sp.rule)) ? str(sp.rule) : "";
  const status = Object.hasOwn(JOB_STATUS_LABEL, str(sp.status)) ? str(sp.status) : "";
  const from = isIsoDate(str(sp.from)) ? str(sp.from) : "";
  const to = isIsoDate(str(sp.to)) ? str(sp.to) : "";
  const supabase = await createClient();

  let query = supabase
    .from("automation_jobs")
    .select("id, status, run_at, executed_at, reason, attempts, rule:automation_rules(id, name), reservation:reservations(id, code, guest:guests(first_name, last_name))")
    .eq("account_id", ctx.active.accountId)
    .order("run_at", { ascending: false })
    .limit(200);
  if (rule) query = query.eq("rule_id", rule);
  if (status) query = query.eq("status", status);
  if (from) query = query.gte("run_at", `${from}T00:00:00Z`);
  if (to) query = query.lte("run_at", `${to}T23:59:59Z`);

  const [{ data: jobs }, { data: rules }] = await Promise.all([
    query.returns<
      { id: string; status: string; run_at: string; executed_at: string | null; reason: string | null; attempts: number; rule: { id: string; name: string } | null; reservation: { id: string; code: string; guest: { first_name: string; last_name: string | null } | null } | null }[]
    >(),
    supabase.from("automation_rules").select("id, name").eq("account_id", ctx.active.accountId).order("name").returns<{ id: string; name: string }[]>(),
  ]);

  return (
    <>
      <PageHeader title="Automation log" description="Every scheduled, sent, skipped, failed and canceled run (latest 200)." />
      <Card className="mb-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter runs">
          <Select name="rule" defaultValue={rule} aria-label="Rule">
            <option value="">All rules</option>
            {(rules ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={status} aria-label="Status">
            <option value="">Any status</option>
            {Object.entries(JOB_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Input type="date" name="from" defaultValue={from} aria-label="From" />
          <Input type="date" name="to" defaultValue={to} aria-label="To" />
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
      </Card>
      <div className="overflow-x-auto rounded-[22px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Rule</th>
              <th className="px-4 py-3">Reservation</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {formatDateTime(j.executed_at ?? j.run_at)}
                  {j.executed_at ? null : <span className="block text-xs text-slate-500">planned</span>}
                </td>
                <td className="px-4 py-2.5">{j.rule ? <Link href={`/automations/${j.rule.id}`} className="hover:underline">{j.rule.name}</Link> : "—"}</td>
                <td className="px-4 py-2.5">
                  {j.reservation ? (
                    <Link href={`/reservations/${j.reservation.id}?tab=automations`} className="hover:underline">
                      <span className="font-mono">{j.reservation.code}</span> · {[j.reservation.guest?.first_name, j.reservation.guest?.last_name].filter(Boolean).join(" ")}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={JOB_STATUS_TONE[j.status] ?? "neutral"}>{JOB_STATUS_LABEL[j.status] ?? j.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                  {j.reason ?? ""}
                  {j.attempts > 1 ? <span className="text-xs text-slate-500"> · {j.attempts} attempts</span> : null}
                </td>
              </tr>
            ))}
            {(jobs ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No runs match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
