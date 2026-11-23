/**
 * Step 7 worker: runs due automation jobs. Claims with a lease (AUT-07), renders the message for
 * the guest's language with live variables, and fails visibly instead of sending a broken message
 * (business rule). Dependencies are injected so the logic is unit-tested without a database.
 */
import { pickBody, type RuleAction } from "@/lib/automations/rules";
import { resolveTemplate } from "@/lib/inbox/variables";

export interface ClaimedJob {
  job_id: string;
  attempts: number;
  account_id: string;
  rule_id: string;
  reservation_id: string;
  run_at: string;
  action: RuleAction;
  override_body: string | null;
  created_by: string | null;
  guest_language: string | null;
}

export type Completion =
  | { outcome: "sent"; body?: string; subject?: string; reason?: string; proposalId?: string }
  | { outcome: "failed" | "skipped"; reason: string };

export interface AutomationDeps {
  claim(limit: number): Promise<ClaimedJob[]>;
  complete(job: ClaimedJob, c: Completion): Promise<boolean>;
  /** Every variable for the reservation, resolved now (null if it is gone). */
  variables(job: ClaimedJob): Promise<Record<string, string> | null>;
  /** Direct email to a fixed address (owner / team). */
  sendEmail(to: string, subject: string, text: string, job: ClaimedJob): Promise<void>;
  /** "Ask the agent": drafts into the approval queue and returns the proposal id. */
  draft(job: ClaimedJob, instructions: string): Promise<string>;
  /** Called once per account that got guest messages, to send them right away. */
  flushOutbox(accountId: string): Promise<void>;
}

export interface RunSummary {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  lost: number;
}

export async function runAutomations(deps: AutomationDeps, limit = 25): Promise<RunSummary> {
  const jobs = await deps.claim(limit);
  const summary: RunSummary = { claimed: jobs.length, sent: 0, failed: 0, skipped: 0, lost: 0 };
  const flush = new Set<string>();

  for (const job of jobs) {
    let result: Completion;
    try {
      result = await execute(deps, job);
    } catch (err) {
      result = { outcome: "failed", reason: `Error: ${(err as Error).message}`.slice(0, 1000) };
    }
    let ok: boolean;
    try {
      ok = await deps.complete(job, result);
    } catch (err) {
      ok = await deps.complete(job, { outcome: "failed", reason: `Could not record the result: ${(err as Error).message}`.slice(0, 1000) }).catch(() => false);
      result = { outcome: "failed", reason: "" };
    }
    if (!ok) summary.lost += 1;
    else summary[result.outcome] += 1;
    if (ok && result.outcome === "sent" && job.action.kind === "message" && job.action.recipient === "guest") flush.add(job.account_id);
  }
  for (const accountId of flush) await deps.flushOutbox(accountId);
  return summary;
}

async function execute(deps: AutomationDeps, job: ClaimedJob): Promise<Completion> {
  const action = job.action;
  if (action.kind === "agent_draft") {
    const proposalId = await deps.draft(job, action.instructions);
    return { outcome: "sent", proposalId, reason: "Draft waiting for approval" };
  }
  const vars = await deps.variables(job);
  if (!vars) return { outcome: "skipped", reason: "The reservation is no longer available" };
  const template = job.override_body ?? pickBody(action, job.guest_language);
  const body = resolveTemplate(template, vars);
  const subject = resolveTemplate(action.subject ?? "", vars);
  const missing = [...new Set([...body.unresolved, ...subject.unresolved])];
  if (missing.length) return { outcome: "failed", reason: `Missing values for: ${missing.join(", ")}` };
  if (action.recipient === "email") {
    if (!action.email) return { outcome: "failed", reason: "No email address on the rule" };
    await deps.sendEmail(action.email, subject.text || "Automation", body.text, job);
    return { outcome: "sent", reason: `Emailed ${action.email}` };
  }
  return { outcome: "sent", body: body.text, subject: subject.text || undefined };
}
