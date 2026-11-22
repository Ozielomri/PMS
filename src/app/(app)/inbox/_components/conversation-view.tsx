import { ActionForm } from "@/components/action-form";
import { Badge, Select } from "@/components/ui";
import { aiStatus } from "@/lib/ai/config";
import type { AuthContext, MembershipSummary } from "@/lib/auth/context";
import { roleHasPermission, isRole } from "@/lib/auth/permissions";
import { CHANNEL_LABELS, isChannel } from "@/lib/inbox/channels";
import { loadConversationContext, type ConversationContext } from "@/lib/inbox/server";
import { VARIABLE_CATALOG } from "@/lib/inbox/variables";
import { createClient } from "@/lib/supabase/server";

import { assignConversation, setConversationStatus } from "../actions";
import { Composer, type ComposerSavedReply } from "./composer";
import { Thread } from "./thread";

type Ctx = AuthContext & { active: MembershipSummary };

export interface TeamMember {
  id: string;
  name: string;
}

/** Active members who can work the inbox (assignment and @mentions). */
export async function inboxMembers(accountId: string): Promise<TeamMember[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("user_id, role, profile:profiles(full_name, email)")
    .eq("account_id", accountId)
    .eq("status", "active")
    .returns<{ user_id: string; role: string; profile: { full_name: string | null; email: string } | null }[]>();
  return (data ?? [])
    .filter((m) => isRole(m.role) && roleHasPermission(m.role, "inbox.view"))
    .map((m) => ({ id: m.user_id, name: m.profile?.full_name ?? m.profile?.email ?? "Member" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Header, thread and composer of one conversation (inbox centre column, reservation Messages tab). */
export async function ConversationView({ ctx, conversationId, timeZone }: { ctx: Ctx; conversationId: string; timeZone: string }) {
  const supabase = await createClient();
  const conv = await loadConversationContext(supabase, conversationId);
  if (!conv) return <p className="text-sm text-slate-500">Conversation not found.</p>;
  const canReply = ctx.can("inbox.reply");
  const canManage = ctx.can("inbox.manage");

  // Opening a conversation marks it read for this user (INB-01 unread marker).
  await supabase.rpc("inbox_mark_read", { p_conversation_id: conversationId });

  const [{ data: replies }, { data: proposal }, { data: fields }, members] = await Promise.all([
    supabase
      .from("saved_replies")
      .select("id, title, shortcut, body, language, variants")
      .eq("account_id", conv.conversation.account_id)
      .is("archived_at", null)
      .order("title")
      .returns<ComposerSavedReply[]>(),
    supabase
      .from("agent_proposals")
      .select("id, content, confidence, needs_human, reasoning_summary")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; content: string; confidence: string | null; needs_human: boolean; reasoning_summary: string | null }>(),
    supabase.from("custom_fields").select("key").eq("account_id", conv.conversation.account_id).is("archived_at", null).order("position").returns<{ key: string }[]>(),
    inboxMembers(conv.conversation.account_id),
  ]);

  const channel = isChannel(conv.conversation.channel) ? conv.conversation.channel : "email";
  const ai = aiStatus();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ConversationHeader conv={conv} members={members} canReply={canReply} canManage={canManage} userId={ctx.user.id} />
      <div className="min-h-40">
        <Thread conversationId={conversationId} timeZone={timeZone} canReply={canReply} reservationId={conv.conversation.reservation_id} />
      </div>
      {canReply ? (
        <Composer
          conversationId={conversationId}
          reservationId={conv.conversation.reservation_id}
          channelLabel={CHANNEL_LABELS[channel]}
          savedReplies={replies ?? []}
          guestLanguage={conv.guest?.language ?? null}
          variableNames={[...VARIABLE_CATALOG.map((v) => v.name), ...(fields ?? []).map((f) => `custom.${f.key}`)]}
          ai={ai.enabled ? { enabled: true } : { enabled: false, reason: ai.reason }}
          initialProposal={
            proposal
              ? { id: proposal.id, content: proposal.content, confidence: proposal.confidence ?? "low", needsHuman: proposal.needs_human, reasoning: proposal.reasoning_summary ?? "" }
              : null
          }
          members={members.filter((m) => m.id !== ctx.user.id)}
        />
      ) : (
        <p className="text-sm text-slate-500">You can read this conversation but not reply.</p>
      )}
    </div>
  );
}

function ConversationHeader({ conv, members, canReply, canManage, userId }: { conv: ConversationContext; members: TeamMember[]; canReply: boolean; canManage: boolean; userId: string }) {
  const c = conv.conversation;
  const name = conv.guest ? [conv.guest.first_name, conv.guest.last_name].filter(Boolean).join(" ") : (c.contact_name ?? c.contact_email ?? "Unknown sender");
  const f = { conversationId: c.id, reservationId: c.reservation_id ?? "" };
  const assignee = members.find((m) => m.id === c.assignee_user_id);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
      <div className="min-w-0">
        <h2 className="font-display text-xl text-slate-900 dark:text-slate-100">{name}</h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <span className="truncate">{c.subject ?? "No subject"}</span>
          {c.status === "done" ? <Badge tone="green">Done</Badge> : c.awaiting_reply_since ? <Badge tone="amber">Unanswered</Badge> : <Badge>Open</Badge>}
          {assignee ? <span>· {assignee.id === userId ? "Assigned to you" : `Assigned to ${assignee.name}`}</span> : <span>· Unassigned</span>}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {canReply && c.assignee_user_id !== userId ? <ActionForm action={assignConversation} fields={{ ...f, userId }} label="Assign to me" variant="ghost" /> : null}
        {canManage ? (
          <ActionForm action={assignConversation} fields={f} label="Assign" variant="ghost" className="flex items-start gap-2">
            <Select name="userId" aria-label="Assignee" defaultValue={c.assignee_user_id ?? ""} className="w-40">
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </ActionForm>
        ) : null}
        {canReply ? (
          c.status === "open" ? (
            <ActionForm action={setConversationStatus} fields={{ ...f, status: "done" }} label="Mark done" />
          ) : (
            <ActionForm action={setConversationStatus} fields={{ ...f, status: "open" }} label="Reopen" />
          )
        ) : null}
      </div>
    </header>
  );
}
