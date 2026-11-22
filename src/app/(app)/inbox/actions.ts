"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import { anthropicProvider } from "@/lib/ai/anthropic";
import { aiStatus } from "@/lib/ai/config";
import { LlmRefusalError } from "@/lib/ai/provider";
import { draftReply } from "@/lib/ai/reply-draft";
import { authorizeAction } from "@/lib/auth/context";
import { channelLimit, channelWarnings, isChannel } from "@/lib/inbox/channels";
import { emailConfig, emailProviderName } from "@/lib/inbox/config";
import { replyAddress } from "@/lib/inbox/email/compose";
import { ingestInboundEmail } from "@/lib/inbox/email/ingest";
import { logProvider } from "@/lib/inbox/email/log";
import { inboxErrorMessage } from "@/lib/inbox/errors";
import { LANGUAGE_PATTERN } from "@/lib/inbox/saved-replies";
import { conversationVariables, kickOutbox, loadConversationContext, loadDraftInput, reservationVariables } from "@/lib/inbox/server";
import { previewTemplate, resolveTemplate, type PreviewPart } from "@/lib/inbox/variables";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type InboxActionResult = { ok?: boolean; error?: string; message?: string } | null;

const uuid = z.guid();

function get(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  return typeof v === "string" ? v : undefined;
}

function revalidateInbox(reservationId?: string | null) {
  revalidatePath("/inbox");
  if (reservationId) revalidatePath(`/reservations/${reservationId}`);
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error: error ? inboxErrorMessage(error.message) : null };
}

// ---------------------------------------------------------------------------
// INB-04 / INB-06: preview and send
// ---------------------------------------------------------------------------

export interface PreviewResult {
  parts: PreviewPart[];
  unresolved: string[];
  warnings: string[];
  length: number;
  limit: number;
}

/** Live preview of the resolved text (variables are resolved on the server, secrets included). */
export async function previewReply(conversationId: string, template: string, channel?: string): Promise<PreviewResult | { error: string }> {
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const ctx = await loadConversationContext(supabase, conversationId);
  if (!ctx) return { error: "Conversation not found." };
  const vars = await conversationVariables(supabase, ctx);
  const resolved = resolveTemplate(template, vars);
  const ch = isChannel(channel) ? channel : isChannel(ctx.conversation.channel) ? ctx.conversation.channel : "email";
  return { parts: previewTemplate(template, vars), unresolved: resolved.unresolved, warnings: channelWarnings(ch, resolved.text), length: resolved.text.length, limit: channelLimit(ch) };
}

export async function sendReply(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  const template = (get(formData, "body") ?? "").trim();
  if (!conversationId.success) return { error: "Invalid request." };
  if (!template) return { error: "Write a message first." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const ctx = await loadConversationContext(supabase, conversationId.data);
  if (!ctx) return { error: "Conversation not found." };
  // INB-06: resolved now, at send time; unresolved variables block sending.
  const { text, unresolved } = resolveTemplate(template, await conversationVariables(supabase, ctx));
  if (unresolved.length) return { error: `Fill in or remove: ${unresolved.map((v) => `{{${v}}}`).join(", ")}. A message with an unresolved variable cannot be sent.` };
  if (text.length > channelLimit("email")) return { error: "The message is too long for this channel." };

  const savedReply = uuid.safeParse(get(formData, "savedReplyId"));
  const proposal = uuid.safeParse(get(formData, "proposalId"));
  const { error } = await rpc("inbox_send_message", {
    p_conversation_id: conversationId.data,
    p_body: text,
    p_body_template: template,
    p_saved_reply_id: savedReply.success ? savedReply.data : null,
    p_proposal_id: proposal.success ? proposal.data : null,
    p_channel: null,
  });
  if (error) return { error };
  // Send now instead of waiting for the schedule (which is off on the Hobby plan).
  after(() => kickOutbox(auth.ctx.active.accountId));
  revalidateInbox(ctx.conversation.reservation_id);
  return { ok: true, message: "Queued for sending." };
}

// ---------------------------------------------------------------------------
// INB-09 notes, INB-08 status and assignment, tags, retry / discard
// ---------------------------------------------------------------------------

export async function addNote(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  const body = (get(formData, "body") ?? "").trim();
  if (!conversationId.success || !body) return { error: "Write a note first." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const mentions = formData.getAll("mentions").filter((m): m is string => typeof m === "string" && uuid.safeParse(m).success);
  const { error } = await rpc("inbox_add_note", { p_conversation_id: conversationId.data, p_body: body, p_mentions: mentions });
  if (error) return { error };
  revalidateInbox(get(formData, "reservationId"));
  return { ok: true, message: "Note added." };
}

export async function setConversationStatus(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  const status = z.enum(["open", "done"]).safeParse(get(formData, "status"));
  if (!conversationId.success || !status.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("inbox_set_status", { p_conversation_id: conversationId.data, p_status: status.data });
  if (error) return { error };
  revalidateInbox(get(formData, "reservationId"));
  return { ok: true, message: status.data === "done" ? "Marked done." : "Reopened." };
}

export async function assignConversation(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  const raw = get(formData, "userId") ?? "";
  const userId = raw === "" ? { success: true as const, data: null } : uuid.safeParse(raw);
  if (!conversationId.success || !userId.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.view");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("inbox_assign", { p_conversation_id: conversationId.data, p_user_id: userId.data });
  if (error) return { error };
  revalidateInbox(get(formData, "reservationId"));
  return { ok: true, message: userId.data ? "Assigned." : "Unassigned." };
}

export async function setConversationTags(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  if (!conversationId.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  const tags = [...new Set((get(formData, "tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 50));
  const { error } = await rpc("inbox_set_tags", { p_conversation_id: conversationId.data, p_tags: tags });
  if (error) return { error };
  revalidateInbox();
  return { ok: true, message: "Tags saved." };
}

export async function retryMessage(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const messageId = uuid.safeParse(get(formData, "messageId"));
  if (!messageId.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("inbox_retry_message", { p_message_id: messageId.data });
  if (error) return { error };
  after(() => kickOutbox(auth.ctx.active.accountId));
  revalidateInbox(get(formData, "reservationId"));
  revalidatePath("/inbox/log");
  return { ok: true, message: "Queued again." };
}

export async function discardMessage(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const messageId = uuid.safeParse(get(formData, "messageId"));
  if (!messageId.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("inbox_discard_message", { p_message_id: messageId.data });
  if (error) return { error };
  revalidateInbox(get(formData, "reservationId"));
  revalidatePath("/inbox/log");
  return { ok: true, message: "Discarded. The message stays in the thread as not sent." };
}

/** Reservation page → Messages tab: open (or create) the guest conversation. */
export async function openReservationConversation(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const reservationId = uuid.safeParse(get(formData, "reservationId"));
  if (!reservationId.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("inbox_open_conversation", { p_reservation_id: reservationId.data });
  if (error) return { error };
  revalidateInbox(reservationId.data);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// INB-11 AI reply draft (approval queue; never sent automatically)
// ---------------------------------------------------------------------------

export type SuggestResult =
  | { ok: true; proposalId: string; content: string; confidence: string; needsHuman: boolean; reasoning: string }
  | { ok: false; error: string };

export async function suggestReply(conversationId: string): Promise<SuggestResult> {
  const status = aiStatus();
  if (!status.enabled) return { ok: false, error: status.reason };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const ctx = await loadConversationContext(supabase, conversationId);
  if (!ctx) return { ok: false, error: "Conversation not found." };
  const { data: settings } = await supabase.from("inbox_settings").select("ai_drafts_enabled").eq("account_id", ctx.conversation.account_id).maybeSingle<{ ai_drafts_enabled: boolean }>();
  if (!settings?.ai_drafts_enabled) return { ok: false, error: "AI reply suggestions are switched off for this account." };

  try {
    const input = await loadDraftInput(supabase, ctx);
    const result = await draftReply(anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: status.model }), input);
    // Stored by the agent itself (actor type `agent`), after the user's access was checked above.
    const agent = createAdminClient({ type: "agent", id: "inbox-drafts" });
    const { data, error } = await agent.rpc("agent_propose_reply", {
      p_conversation_id: ctx.conversation.id,
      p_content: result.draft.reply,
      p_requested_by: auth.ctx.user.id,
      p_reasoning_summary: result.draft.reasoningSummary,
      p_confidence: result.draft.confidence,
      p_needs_human: result.draft.needsHuman,
      p_grounding: result.grounding,
      p_model: result.model,
      p_input_tokens: result.inputTokens,
      p_output_tokens: result.outputTokens,
    });
    if (error) return { ok: false, error: inboxErrorMessage(error.message) };
    return { ok: true, proposalId: String(data), content: result.draft.reply, confidence: result.draft.confidence, needsHuman: result.draft.needsHuman, reasoning: result.draft.reasoningSummary };
  } catch (err) {
    if (err instanceof LlmRefusalError) return { ok: false, error: "The AI declined to draft this reply. Write it yourself." };
    console.error("[inbox] suggest reply failed:", (err as Error).message);
    return { ok: false, error: "The AI suggestion failed. Try again or write the reply yourself." };
  }
}

export async function rejectProposal(proposalId: string): Promise<InboxActionResult> {
  if (!uuid.safeParse(proposalId).success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.reply");
  if (!auth.ok) return { error: auth.error };
  const { error } = await rpc("reject_agent_proposal", { p_proposal_id: proposalId });
  return error ? { error } : { ok: true };
}

// ---------------------------------------------------------------------------
// Development: simulate a guest reply through the real inbound path (log adapter only)
// ---------------------------------------------------------------------------

export async function simulateGuestReply(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  if (emailProviderName() !== "log") return { error: "Only available with the development email adapter." };
  const conversationId = uuid.safeParse(get(formData, "conversationId"));
  const text = (get(formData, "text") ?? "").trim();
  if (!conversationId.success || !text) return { error: "Write the guest's message." };
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  if (!process.env.SUPABASE_SECRET_KEY) return { error: "Set SUPABASE_SECRET_KEY on the server to simulate inbound email." };
  const supabase = await createClient();
  const ctx = await loadConversationContext(supabase, conversationId.data);
  if (!ctx) return { error: "Conversation not found." };
  const { data: settings } = await supabase.from("inbox_settings").select("inbound_token").eq("account_id", ctx.conversation.account_id).maybeSingle<{ inbound_token: string }>();
  if (!settings) return { error: "Inbox settings not found." };
  const from = ctx.conversation.contact_email ?? ctx.guest?.email;
  if (!from) return { error: "The conversation has no guest email address." };
  const config = emailConfig();
  const inbound = logProvider().parseInbound({
    message_id: `sim-${randomUUID()}`,
    from: `${ctx.guest?.first_name ?? ctx.conversation.contact_name ?? "Guest"} <${from}>`,
    to: [replyAddress(settings.inbound_token, ctx.conversation.reply_token, config.inboundDomain)],
    subject: `Re: ${ctx.conversation.subject ?? "Your stay"}`,
    text,
  });
  try {
    await ingestInboundEmail(createAdminClient({ type: "channel", id: "email-simulator" }), "log", inbound, config.inboundDomain);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidateInbox(ctx.conversation.reservation_id);
  return { ok: true, message: "Guest reply received." };
}

// ---------------------------------------------------------------------------
// INB-05 saved replies and inbox settings
// ---------------------------------------------------------------------------

const savedReplySchema = z.object({
  id: z.union([uuid, z.literal("")]).optional(),
  title: z.string().trim().min(1, "Enter a title").max(100),
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .max(30)
    .refine((v) => v === "" || /^[a-z0-9][a-z0-9_-]{0,29}$/.test(v), "Shortcut: letters, digits, - and _ only")
    .optional(),
  body: z.string().trim().min(1, "Write the reply").max(10000),
  language: z.string().regex(LANGUAGE_PATTERN).default("en"),
});

export async function saveSavedReply(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const parsed = savedReplySchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  const d = parsed.data;
  const variants: Record<string, string> = {};
  const langs = formData.getAll("variantLanguage");
  const bodies = formData.getAll("variantBody");
  langs.forEach((l, i) => {
    const body = typeof bodies[i] === "string" ? (bodies[i] as string).trim() : "";
    if (typeof l === "string" && LANGUAGE_PATTERN.test(l) && l !== d.language && body) variants[l] = body.slice(0, 10000);
  });
  const row = { title: d.title, shortcut: d.shortcut || null, body: d.body, language: d.language, variants };
  const supabase = await createClient();
  const { error } = d.id
    ? await supabase.from("saved_replies").update(row).eq("id", d.id)
    : await supabase.from("saved_replies").insert({ ...row, account_id: auth.ctx.active.accountId });
  if (error) return { error: inboxErrorMessage(error.message) };
  revalidatePath("/inbox/saved-replies");
  revalidatePath("/inbox");
  return { ok: true, message: "Saved." };
}

export async function archiveSavedReply(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const id = uuid.safeParse(get(formData, "id"));
  if (!id.success) return { error: "Invalid request." };
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase.from("saved_replies").update({ archived_at: new Date().toISOString() }).eq("id", id.data);
  if (error) return { error: inboxErrorMessage(error.message) };
  revalidatePath("/inbox/saved-replies");
  return { ok: true, message: "Archived." };
}

/** Saved-reply editor preview against a sample reservation. */
export async function previewSavedReply(reservationId: string, template: string): Promise<{ parts: PreviewPart[]; unresolved: string[] } | { error: string }> {
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const vars = await reservationVariables(supabase, reservationId, auth.ctx.active.accountName);
  if (!vars) return { error: "Pick a sample reservation." };
  return { parts: previewTemplate(template, vars), unresolved: resolveTemplate(template, vars).unresolved };
}

export async function updateInboxSettings(_prev: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorizeAction("inbox.manage");
  if (!auth.ok) return { error: auth.error };
  const sender = (get(formData, "senderName") ?? "").trim().slice(0, 100);
  const supabase = await createClient();
  const { error } = await supabase
    .from("inbox_settings")
    .update({ sender_name: sender || null, ai_drafts_enabled: get(formData, "aiDrafts") === "on" })
    .eq("account_id", auth.ctx.active.accountId);
  if (error) return { error: inboxErrorMessage(error.message) };
  revalidatePath("/inbox/log");
  return { ok: true, message: "Saved." };
}
