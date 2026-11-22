import { ActionForm } from "@/components/action-form";
import { Badge, cx, formatDateTime } from "@/components/ui";
import { CHANNEL_LABELS, type Channel } from "@/lib/inbox/channels";
import { deliveryLabel, deliveryTone, type DeliveryStatus } from "@/lib/inbox/delivery";
import { formatDuration } from "@/lib/inbox/format";
import { createClient } from "@/lib/supabase/server";

import { discardMessage, retryMessage } from "../actions";

interface MessageRow {
  id: string;
  kind: "inbound" | "outbound" | "note";
  channel: Channel | "internal";
  author_type: string;
  sender_name: string | null;
  sender_email: string | null;
  recipient_email: string | null;
  body: string;
  attachments: { name: string; content_type: string; size: number }[];
  mentions: string[];
  proposal_id: string | null;
  saved_reply_id: string | null;
  response_seconds: number | null;
  created_at: string;
  author: { full_name: string | null; email: string } | null;
  delivery: { status: DeliveryStatus; last_error: string | null; attempts: number; sent_at: string | null; delivered_at: string | null } | null;
}

/** The messages of one conversation, oldest first (INB-04 thread, INB-09 notes, INB-10 statuses). */
export async function Thread({ conversationId, timeZone, canReply, reservationId }: { conversationId: string; timeZone: string; canReply: boolean; reservationId?: string | null }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("messages")
    .select(
      "id, kind, channel, author_type, sender_name, sender_email, recipient_email, body, attachments, mentions, proposal_id, saved_reply_id, response_seconds, created_at, " +
        "author:profiles!messages_author_user_id_fkey(full_name, email), delivery:message_deliveries(status, last_error, attempts, sent_at, delivered_at)",
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500)
    .returns<MessageRow[]>();
  // The delivery is one row per message; PostgREST may return it as a one-element array.
  const messages = (data ?? []).map((m) => ({ ...m, delivery: Array.isArray(m.delivery) ? ((m.delivery[0] as MessageRow["delivery"]) ?? null) : m.delivery }));
  if (messages.length === 0) {
    return <p className="py-10 text-center text-sm text-slate-500">No messages yet. Write the first one below.</p>;
  }
  return (
    <ol className="space-y-4" aria-label="Messages">
      {messages.map((m) => (
        <li key={m.id} className={cx("flex", m.kind === "inbound" ? "justify-start" : "justify-end")}>
          <article
            className={cx(
              "max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm",
              m.kind === "inbound" && "rounded-bl-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900",
              m.kind === "outbound" && "rounded-br-sm bg-brand-50 text-slate-900 dark:bg-brand-800/40 dark:text-slate-100",
              m.kind === "note" && "rounded-br-sm border border-dashed border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100",
            )}
          >
            <header className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {m.kind === "inbound" ? (m.sender_name ?? m.sender_email ?? "Guest") : m.author_type === "agent" ? "AI agent" : (m.author?.full_name ?? m.author?.email ?? "Team")}
              </span>
              {m.kind === "note" ? <Badge tone="amber">Internal note · not sent to the guest</Badge> : <span>{CHANNEL_LABELS[m.channel]}</span>}
              {m.proposal_id ? <Badge>AI draft</Badge> : null}
              <time dateTime={m.created_at}>{formatDateTime(m.created_at, timeZone)}</time>
            </header>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
            {m.attachments?.length ? (
              <ul className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                {m.attachments.map((a, i) => (
                  <li key={i} className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                    📎 {a.name} ({Math.max(1, Math.round(a.size / 1024))} KB)
                  </li>
                ))}
              </ul>
            ) : null}
            {m.kind === "outbound" && m.delivery ? (
              <footer className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <Badge tone={deliveryTone(m.delivery.status)}>{deliveryLabel(m.delivery.status)}</Badge>
                {m.recipient_email ? <span>to {m.recipient_email}</span> : null}
                {m.response_seconds !== null ? <span>· replied in {formatDuration(m.response_seconds)}</span> : null}
                {m.delivery.status === "failed" ? <span className="text-red-700 dark:text-red-300">{m.delivery.last_error}</span> : null}
              </footer>
            ) : null}
            {canReply && m.kind === "outbound" && m.delivery?.status === "failed" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <ActionForm action={retryMessage} fields={{ messageId: m.id, reservationId: reservationId ?? "" }} label="Retry" />
                <ActionForm action={discardMessage} fields={{ messageId: m.id, reservationId: reservationId ?? "" }} label="Discard" variant="ghost" confirm="Discard this message? It stays in the thread as not sent." />
              </div>
            ) : null}
          </article>
        </li>
      ))}
    </ol>
  );
}
