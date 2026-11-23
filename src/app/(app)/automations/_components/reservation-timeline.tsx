import Link from "next/link";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, formatDateTime } from "@/components/ui";
import { describeTiming, pickBody, type RuleAction, type Trigger } from "@/lib/automations/rules";
import { createClient } from "@/lib/supabase/server";

import { editJob, sendJobNow, skipJob } from "../actions";
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from "./job-status";

interface JobRow {
  id: string;
  status: string;
  run_at: string;
  executed_at: string | null;
  reason: string | null;
  override_body: string | null;
  message_id: string | null;
  proposal_id: string | null;
  rule: { id: string; name: string; trigger: Trigger; offset_minutes: number; at_time: string | null; action: RuleAction } | null;
}

/** AUT-06: every automation run for one reservation, with skip / send now / edit this message. */
export async function ReservationTimeline({ reservationId, timeZone, canEdit, guestLanguage }: { reservationId: string; timeZone: string; canEdit: boolean; guestLanguage: string | null }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("automation_jobs")
    .select("id, status, run_at, executed_at, reason, override_body, message_id, proposal_id, rule:automation_rules(id, name, trigger, offset_minutes, at_time, action)")
    .eq("reservation_id", reservationId)
    .order("run_at")
    .returns<JobRow[]>();
  const jobs = data ?? [];
  return (
    <Card title="Automations" description={`Times in the listing's timezone (${timeZone}). Messages move with the booking when dates or arrival times change.`}>
      {jobs.length === 0 ? (
        <p className="text-sm text-slate-500">
          No automations apply to this reservation. <Link href="/automations" className="underline">Set up automations</Link>
        </p>
      ) : null}
      <ol className="relative flex flex-col gap-5 border-l border-slate-200 pl-6 dark:border-slate-800">
        {jobs.map((j) => {
          const editable = canEdit && (j.status === "scheduled" || j.status === "failed");
          const template = j.rule?.action.kind === "message" ? (j.override_body ?? pickBody(j.rule.action, guestLanguage)) : null;
          return (
            <li key={j.id} className="relative">
              <span aria-hidden className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand-600 dark:border-slate-900" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{j.rule ? <Link href={`/automations/${j.rule.id}`} className="hover:underline">{j.rule.name}</Link> : "Deleted rule"}</p>
                  <p className="text-xs text-slate-500">
                    {j.rule ? describeTiming(j.rule) : ""} · {formatDateTime(j.executed_at ?? j.run_at, timeZone)}
                  </p>
                </div>
                <Badge tone={JOB_STATUS_TONE[j.status] ?? "neutral"}>{JOB_STATUS_LABEL[j.status] ?? j.status}</Badge>
              </div>
              {j.reason ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{j.reason}</p> : null}
              {j.message_id ? (
                <Link href={`/reservations/${reservationId}?tab=messages`} className="mt-1 inline-block text-sm text-brand-700 hover:underline">
                  See the message →
                </Link>
              ) : null}
              {j.proposal_id ? (
                <Link href={`/reservations/${reservationId}?tab=messages`} className="mt-1 inline-block text-sm text-brand-700 hover:underline">
                  Review the agent&apos;s draft →
                </Link>
              ) : null}
              {editable ? (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <ActionForm action={sendJobNow} fields={{ jobId: j.id, reservationId }} label={j.status === "failed" ? "Retry now" : "Send now"} variant="secondary" />
                  {j.status === "scheduled" ? <ActionForm action={skipJob} fields={{ jobId: j.id, reservationId }} label="Skip" variant="ghost" confirm="Skip this message for this reservation?" /> : null}
                </div>
              ) : null}
              {editable && template !== null ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">{j.override_body ? "Edited for this reservation — change" : "Edit this message only"}</summary>
                  <ActionForm action={editJob} fields={{ jobId: j.id, reservationId }} label="Save for this reservation" variant="secondary" className="mt-2 flex flex-col gap-2">
                    <textarea
                      name="body"
                      rows={6}
                      defaultValue={template}
                      aria-label="Message for this reservation"
                      className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                  </ActionForm>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
