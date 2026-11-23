"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import type { Permission } from "@/lib/auth/permissions";
import { payloadFromForm, pickBody, STARTERS, type RulePayload } from "@/lib/automations/rules";
import { runAutomationsNow } from "@/lib/automations/server";
import { emailConfig, emailProvider } from "@/lib/inbox/config";
import { reservationVariables } from "@/lib/inbox/server";
import { resolveTemplate } from "@/lib/inbox/variables";
import { createClient } from "@/lib/supabase/server";

export type AutomationActionResult = { ok?: boolean; error?: string; message?: string } | null;

const uuid = z.guid();

/** "invalid_rule: give the rule a name" → "Give the rule a name". */
function friendly(message: string | undefined): string {
  const m = message ?? "";
  if (m.startsWith("forbidden")) return "You do not have permission to do that.";
  if (m.startsWith("rule_not_found") || m.startsWith("job_not_found")) return "Not found. It may have been deleted.";
  if (m.startsWith("job_not_scheduled")) return "This run has already happened or was canceled.";
  const detail = m.split(": ").slice(1).join(": ");
  if (m.startsWith("invalid_rule") && detail) return detail[0].toUpperCase() + detail.slice(1) + ".";
  return "Something went wrong. Try again.";
}

function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v !== "string") continue;
    out[k] = out[k] && ["listing_ids", "exclude_listing_ids", "sources"].includes(k) ? `${out[k]},${v}` : v;
  }
  return out;
}

async function rpc(permission: Permission, fn: string, args: Record<string, unknown>) {
  const auth = await authorizeAction(permission);
  if (!auth.ok) return { error: auth.error, auth: null, data: null };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  return { error: error ? friendly(error.message) : undefined, auth: auth.ctx, data };
}

function revalidate(reservationId?: string) {
  revalidatePath("/automations");
  revalidatePath("/automations/log");
  if (reservationId) revalidatePath(`/reservations/${reservationId}`);
}

// ---------------------------------------------------------------------------
// Rules (AUT-01, AUT-11)
// ---------------------------------------------------------------------------

export async function saveRule(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const fields = formObject(formData);
  const ruleId = fields.rule_id && uuid.safeParse(fields.rule_id).success ? fields.rule_id : null;
  const { payload, error } = payloadFromForm(fields);
  if (!payload) return { error };
  const auth = await authorizeAction("automations.edit");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error: rpcError } = await supabase.rpc("save_automation_rule", { p_account_id: auth.ctx.active.accountId, p_rule_id: ruleId, p_payload: payload });
  if (rpcError) return { error: friendly(rpcError.message) };
  revalidate();
  if (!ruleId) redirect(`/automations/${String(data)}?created=1`);
  return { ok: true, message: "Saved. Scheduled runs that have not happened yet now follow the new settings." };
}

export async function setRuleStatus(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("ruleId"));
  const status = z.enum(["active", "paused"]).safeParse(formData.get("status"));
  if (!id.success || !status.success) return { error: "Invalid request." };
  const { error } = await rpc("automations.edit", "set_automation_rule_status", { p_rule_id: id.data, p_status: status.data });
  if (error) return { error };
  revalidate();
  revalidatePath(`/automations/${id.data}`);
  return { ok: true, message: status.data === "active" ? "Rule active: future runs are scheduled." : "Rule paused: pending runs are canceled." };
}

export async function deleteRule(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("ruleId"));
  if (!id.success) return { error: "Invalid request." };
  const { error } = await rpc("automations.manage", "delete_automation_rule", { p_rule_id: id.data });
  if (error) return { error };
  revalidate();
  redirect("/automations");
}

export async function duplicateRule(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("ruleId"));
  if (!id.success) return { error: "Invalid request." };
  const auth = await authorizeAction("automations.edit");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data: rule } = await supabase.from("automation_rules").select("name, trigger, offset_minutes, at_time, conditions, action, expire_after_hours").eq("id", id.data).maybeSingle<Omit<RulePayload, "status">>();
  if (!rule) return { error: "Not found." };
  const payload: RulePayload = { ...rule, at_time: rule.at_time ? rule.at_time.slice(0, 5) : null, name: `${rule.name} (copy)`.slice(0, 120), status: "paused" };
  const { data, error } = await supabase.rpc("save_automation_rule", { p_account_id: auth.ctx.active.accountId, p_rule_id: null, p_payload: payload });
  if (error) return { error: friendly(error.message) };
  revalidate();
  redirect(`/automations/${String(data)}`);
}

export async function addStarter(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const starter = STARTERS.find((s) => s.key === formData.get("key"));
  if (!starter) return { error: "Unknown starter rule." };
  const auth = await authorizeAction("automations.edit");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_automation_rule", {
    p_account_id: auth.ctx.active.accountId,
    p_rule_id: null,
    p_payload: { ...starter.payload, status: "active", starter_key: starter.key },
  });
  if (error) return { error: friendly(error.message) };
  revalidate();
  return { ok: true, message: `“${starter.title}” is on.` };
}

// ---------------------------------------------------------------------------
// AUT-10 preview and test
// ---------------------------------------------------------------------------

export interface PreviewResult {
  error?: string;
  count?: number;
  next?: { reservation_id: string; code: string; run_at: string }[];
  rendered?: { subject: string; body: string; missing: string[] } | null;
}

export async function previewRule(fields: Record<string, string>, reservationId: string | null): Promise<PreviewResult> {
  const { payload, error } = payloadFromForm(fields);
  if (!payload) return { error };
  const auth = await authorizeAction("automations.view");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error: rpcError } = await supabase.rpc("preview_automation_rule", { p_account_id: auth.ctx.active.accountId, p_payload: payload });
  if (rpcError) return { error: friendly(rpcError.message) };
  const result = data as { count: number; next: PreviewResult["next"] };
  let rendered: PreviewResult["rendered"] = null;
  if (reservationId && uuid.safeParse(reservationId).success && payload.action.kind === "message") {
    const vars = await reservationVariables(supabase, reservationId, auth.ctx.active.accountName);
    if (vars) {
      const { data: g } = await supabase.from("reservations").select("guest:guests(language)").eq("id", reservationId).maybeSingle<{ guest: { language: string | null } | null }>();
      const body = resolveTemplate(pickBody(payload.action, g?.guest?.language), vars);
      const subject = resolveTemplate(payload.action.subject ?? "", vars);
      rendered = { body: body.text, subject: subject.text, missing: [...new Set([...body.unresolved, ...subject.unresolved])] };
    }
  }
  return { count: result.count, next: result.next, rendered };
}

export async function sendTest(fields: Record<string, string>, reservationId: string): Promise<{ ok?: boolean; error?: string; message?: string }> {
  const preview = await previewRule(fields, reservationId);
  if (preview.error) return { error: preview.error };
  if (!preview.rendered) return { error: "Choose a sample reservation for a message rule." };
  if (preview.rendered.missing.length) return { error: `Missing values for: ${preview.rendered.missing.join(", ")}` };
  const auth = await authorizeAction("automations.view");
  if (!auth.ok || !auth.ctx.user.email) return { error: "Your account has no email address." };
  const from = emailConfig().fromAddress;
  try {
    const provider = emailProvider();
    await provider.send({
      from,
      to: auth.ctx.user.email,
      replyTo: from,
      subject: `[Test] ${preview.rendered.subject || "Automation preview"}`,
      text: preview.rendered.body,
      headers: {},
      tag: "automation-test",
    });
    return { ok: true, message: provider.name === "log" ? "Test recorded. Email is in test mode, so nothing was actually sent." : `Test sent to ${auth.ctx.user.email}.` };
  } catch (err) {
    return { error: `The test could not be sent: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// AUT-06 single runs
// ---------------------------------------------------------------------------

export async function skipJob(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("jobId"));
  if (!id.success) return { error: "Invalid request." };
  const { error } = await rpc("automations.edit", "skip_automation_job", { p_job_id: id.data });
  if (error) return { error };
  revalidate(String(formData.get("reservationId") ?? ""));
  return { ok: true, message: "Skipped." };
}

export async function sendJobNow(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("jobId"));
  if (!id.success) return { error: "Invalid request." };
  const { error } = await rpc("automations.edit", "send_automation_job_now", { p_job_id: id.data });
  if (error) return { error };
  const summary = await runAutomationsNow(10);
  revalidate(String(formData.get("reservationId") ?? ""));
  return { ok: true, message: summary ? "Done. See the result below." : "Queued: it runs with the next automation run." };
}

export async function editJob(_prev: AutomationActionResult, formData: FormData): Promise<AutomationActionResult> {
  const id = uuid.safeParse(formData.get("jobId"));
  const body = z.string().trim().min(1, "Write the message").max(10000).safeParse(formData.get("body"));
  if (!id.success) return { error: "Invalid request." };
  if (!body.success) return { error: body.error.issues[0]?.message };
  const { error } = await rpc("automations.edit", "edit_automation_job", { p_job_id: id.data, p_body: body.data });
  if (error) return { error };
  revalidate(String(formData.get("reservationId") ?? ""));
  return { ok: true, message: "This message will use your text. The rule is unchanged." };
}
