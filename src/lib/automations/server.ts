import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { anthropicProvider } from "@/lib/ai/anthropic";
import { aiStatus } from "@/lib/ai/config";
import { draftReply } from "@/lib/ai/reply-draft";
import { runAutomations, type AutomationDeps, type ClaimedJob, type RunSummary } from "@/lib/automations/runner";
import { emailConfig, emailProvider } from "@/lib/inbox/config";
import { kickOutbox, loadConversationContext, loadDraftInput, reservationVariables } from "@/lib/inbox/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** The worker's dependencies against Supabase (service role, actor `automation`). */
export function supabaseAutomationDeps(client: SupabaseClient): AutomationDeps {
  const accountNames = new Map<string, string>();
  const accountName = async (id: string) => {
    if (!accountNames.has(id)) {
      const { data } = await client.from("accounts").select("name").eq("id", id).maybeSingle<{ name: string }>();
      accountNames.set(id, data?.name ?? "");
    }
    return accountNames.get(id)!;
  };

  return {
    async claim(limit) {
      const { data, error } = await client.rpc("claim_automation_jobs", { p_limit: limit, p_lease_seconds: 120 });
      if (error) throw new Error(`claim_automation_jobs: ${error.message}`);
      return (data ?? []) as ClaimedJob[];
    },
    async complete(job, c) {
      const { data, error } = await client.rpc("complete_automation_job", {
        p_job_id: job.job_id,
        p_attempt: job.attempts,
        p_outcome: c.outcome,
        p_body: c.outcome === "sent" ? (c.body ?? null) : null,
        p_subject: c.outcome === "sent" ? (c.subject ?? null) : null,
        p_reason: c.reason ?? null,
        p_proposal_id: c.outcome === "sent" ? (c.proposalId ?? null) : null,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async variables(job) {
      return reservationVariables(client, job.reservation_id, await accountName(job.account_id));
    },
    async sendEmail(to, subject, text, job) {
      const from = emailConfig().fromAddress;
      await emailProvider().send({ from, to, replyTo: from, subject, text, headers: {}, tag: `automation-${job.job_id}` });
    },
    async draft(job, instructions) {
      const status = aiStatus();
      if (!status.enabled) throw new Error(`AI drafts are not set up: ${status.reason}`);
      if (!job.created_by) throw new Error("The rule has no owner to request the draft");
      const { data: conversationId, error } = await client.rpc("automation_job_conversation", { p_job_id: job.job_id });
      if (error || !conversationId) throw new Error(error?.message ?? "No conversation for this reservation");
      const ctx = await loadConversationContext(client, String(conversationId));
      if (!ctx) throw new Error("Conversation not found");
      const input = { ...(await loadDraftInput(client, ctx)), instructions };
      const result = await draftReply(anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: status.model }), input);
      const agent = createAdminClient({ type: "agent", id: `automation:${job.rule_id}` });
      const { data, error: proposeError } = await agent.rpc("agent_propose_reply", {
        p_conversation_id: ctx.conversation.id,
        p_content: result.draft.reply,
        p_requested_by: job.created_by,
        p_reasoning_summary: result.draft.reasoningSummary,
        p_confidence: result.draft.confidence,
        p_needs_human: result.draft.needsHuman,
        p_grounding: result.grounding,
        p_model: result.model,
        p_input_tokens: result.inputTokens,
        p_output_tokens: result.outputTokens,
      });
      if (proposeError) throw new Error(proposeError.message);
      return String(data);
    },
    flushOutbox: kickOutbox,
  };
}

/** Runs due jobs now (the schedule is the fallback; "Send now" calls this). Never throws. */
export async function runAutomationsNow(limit = 25): Promise<RunSummary | null> {
  if (!process.env.SUPABASE_SECRET_KEY) return null;
  try {
    return await runAutomations(supabaseAutomationDeps(createAdminClient({ type: "automation", id: "automations" })), limit);
  } catch (err) {
    console.error("[automations] run failed:", (err as Error).message);
    return null;
  }
}
