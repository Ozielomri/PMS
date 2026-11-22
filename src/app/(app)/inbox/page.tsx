import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Button, Input, PageHeader, Select, Skeleton, cx } from "@/components/ui";
import { requireAuthContext, type AuthContext, type MembershipSummary } from "@/lib/auth/context";
import { CHANNELS, CHANNEL_ICONS, CHANNEL_LABELS } from "@/lib/inbox/channels";
import { INBOX_TABS, inboxFiltersToQuery, parseInboxFilters, type InboxFilters } from "@/lib/inbox/filters";
import { initials, timeSince } from "@/lib/inbox/format";
import { STATUS_LABELS, type ReservationStatus } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { formatDate } from "../reservations/_components/bits";
import { ContextPanel } from "./_components/context-panel";
import { ConversationView } from "./_components/conversation-view";
import { InboxLive } from "./_components/inbox-live";

export const metadata: Metadata = { title: "Inbox" };

type Ctx = AuthContext & { active: MembershipSummary };

export default function InboxPage({ searchParams }: PageProps<"/inbox">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}

export interface ListRow {
  id: string;
  channel: string;
  status: "open" | "done";
  assignee_user_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  tags: string[];
  awaiting_reply_since: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_kind: string | null;
  last_guest_message_at: string | null;
  guest_name: string | null;
  reservation_code: string | null;
  reservation_status: ReservationStatus | null;
  stay_status: string | null;
  check_in: string | null;
  check_out: string | null;
  listing_name: string | null;
  listing_timezone: string | null;
  unread: boolean;
}

const LIST_SELECT =
  "id, channel, status, assignee_user_id, assignee_name, assignee_email, tags, awaiting_reply_since, last_message_at, last_message_preview, last_message_kind, " +
  "last_guest_message_at, guest_name, reservation_code, reservation_status, stay_status, check_in, check_out, listing_name, listing_timezone, unread";

async function listConversations(ctx: Ctx, f: InboxFilters): Promise<{ rows: ListRow[]; snippets: Map<string, string> }> {
  const supabase = await createClient();
  let q = supabase.from("inbox_conversation_list").select(LIST_SELECT).eq("account_id", ctx.active.accountId);
  switch (f.tab) {
    case "unanswered":
      q = q.eq("status", "open").not("awaiting_reply_since", "is", null).order("awaiting_reply_since", { ascending: true });
      break;
    case "mine":
      q = q.eq("assignee_user_id", ctx.user.id).eq("status", "open");
      break;
    case "unassigned":
      q = q.is("assignee_user_id", null).eq("status", "open");
      break;
    case "pending":
      q = q.eq("reservation_status", "reserved");
      break;
    case "arriving":
      q = q.eq("arriving_soon", true);
      break;
    case "in_house":
      q = q.eq("stay_status", "checked_in");
      break;
    case "done":
      q = q.eq("status", "done");
      break;
  }
  if (f.channel) q = q.eq("channel", f.channel);
  // Each filter is an OR group; groups are combined with AND in one PostgREST `or` parameter.
  const groups: string[] = [];
  if (f.listing) groups.push(`listing_id.eq.${f.listing},parent_listing_id.eq.${f.listing}`);
  const tag = f.tag.replace(/[{}(),"\\]/g, "").trim();
  if (tag) groups.push(`tags.cs.{"${tag}"},listing_tags.cs.{"${tag}"}`);

  // INB-14: words in any message, or the guest's name / email / confirmation code.
  const snippets = new Map<string, string>();
  if (f.q.length >= 2) {
    const { data: hits } = await supabase.rpc("search_inbox", { p_account_id: ctx.active.accountId, p_query: f.q, p_limit: 100 });
    for (const h of (hits ?? []) as { conversation_id: string; snippet: string }[]) if (!snippets.has(h.conversation_id)) snippets.set(h.conversation_id, h.snippet);
    const like = f.q.replace(/[%_,()*]/g, " ").trim();
    const ids = [...snippets.keys()];
    groups.push([`guest_name.ilike.*${like}*`, `guest_email.ilike.*${like}*`, `reservation_code.ilike.${like}*`, ...(ids.length ? [`id.in.(${ids.join(",")})`] : [])].join(","));
  }
  if (groups.length === 1) q = q.or(groups[0]);
  else if (groups.length > 1) q = q.or(`and(${groups.map((g) => `or(${g})`).join(",")})`);
  if (f.tab !== "unanswered") q = q.order("last_message_at", { ascending: false, nullsFirst: false });
  const { data } = await q.limit(200).returns<ListRow[]>();
  return { rows: data ?? [], snippets };
}

async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "inbox.view", returnTo: "/inbox" });
  const f = parseInboxFilters(await searchParams);
  const supabase = await createClient();
  const accountId = ctx.active.accountId;

  const [{ rows, snippets }, { count: unanswered }, { count: mine }, { data: listings }] = await Promise.all([
    listConversations(ctx, f),
    supabase.from("conversations").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", "open").not("awaiting_reply_since", "is", null),
    supabase.from("conversations").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", "open").eq("assignee_user_id", ctx.user.id),
    supabase.from("listings").select("id, internal_name").eq("account_id", accountId).neq("type", "sub_unit").neq("status", "archived").order("internal_name").limit(500).returns<{ id: string; internal_name: string }[]>(),
  ]);
  const selected = f.conversation;
  const now = new Date();
  const href = (patch: Partial<InboxFilters>) => {
    const qs = inboxFiltersToQuery(f, patch);
    return qs ? `/inbox?${qs}` : "/inbox";
  };
  const counts: Partial<Record<string, number>> = { unanswered: unanswered ?? 0, mine: mine ?? 0 };

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every guest conversation in one place. Replies go back through the channel the guest wrote on."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <InboxLive accountId={accountId} />
            {ctx.can("inbox.manage") ? (
              <>
                <Link href="/inbox/saved-replies" className="rounded-full border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                  Saved replies
                </Link>
                <Link href="/inbox/log" className="rounded-full border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                  Message log
                </Link>
              </>
            ) : null}
          </div>
        }
      />

      <nav aria-label="Inbox views" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {INBOX_TABS.map(([tab, label]) => (
          <Link
            key={tab}
            href={href({ tab, conversation: "" })}
            aria-current={f.tab === tab ? "page" : undefined}
            className={cx(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              f.tab === tab ? "border-slate-900 font-medium text-slate-900 dark:border-slate-100 dark:text-white" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {label}
            {counts[tab] ? <span className="rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">{counts[tab]}</span> : null}
          </Link>
        ))}
      </nav>

      <form action="/inbox" className="mb-4 flex flex-wrap items-end gap-2" role="search">
        {f.tab !== "unanswered" ? <input type="hidden" name="tab" value={f.tab} /> : null}
        <Input name="q" defaultValue={f.q} placeholder="Search messages, guests, codes…" aria-label="Search conversations" className="w-64" />
        <Select name="channel" defaultValue={f.channel} aria-label="Channel" className="w-40">
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </Select>
        <Select name="listing" defaultValue={f.listing} aria-label="Listing" className="w-48">
          <option value="">All listings</option>
          {(listings ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.internal_name}
            </option>
          ))}
        </Select>
        <Input name="tag" defaultValue={f.tag} placeholder="Tag" aria-label="Tag" className="w-32" />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {f.q || f.channel || f.listing || f.tag ? (
          <Link href={href({ q: "", channel: "", listing: "", tag: "", conversation: "" })} className="px-2 py-2 text-sm text-slate-500 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      {/* Three columns on desktop, two on tablet (context below the thread), stacked on mobile. */}
      <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <section aria-label="Conversations" className={cx("min-w-0 md:row-span-2 xl:row-span-1", selected && "hidden md:block")}>
          {rows.length === 0 ? (
            <p className="rounded-[22px] border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
              {f.tab === "unanswered" && !f.q ? "Nothing waiting. Every guest has an answer." : "No conversations match."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 overflow-hidden rounded-[22px] border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {rows.map((c) => (
                <li key={c.id}>
                  <ConversationItem c={c} active={c.id === selected} href={href({ conversation: c.id })} now={now} snippet={snippets.get(c.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Conversation" className={cx("min-w-0", !selected && "hidden md:block")}>
          {selected ? (
            <div className="space-y-4">
              <Link href={href({ conversation: "" })} className="text-sm text-slate-500 hover:underline md:hidden">
                ← All conversations
              </Link>
              <Suspense fallback={<Skeleton lines={6} />}>
                <ConversationView ctx={ctx} conversationId={selected} timeZone={rows.find((r) => r.id === selected)?.listing_timezone ?? "America/New_York"} />
              </Suspense>
            </div>
          ) : (
            <p className="rounded-[22px] border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500 dark:border-slate-700">Choose a conversation.</p>
          )}
        </section>

        {selected ? (
          <section
            aria-label="Details"
            className="min-w-0 self-start rounded-[22px] border border-slate-200 bg-white p-4 md:col-start-2 xl:col-start-3 xl:row-start-1 dark:border-slate-800 dark:bg-slate-900"
          >
            <Suspense fallback={<Skeleton lines={6} />}>
              <ContextPanel ctx={ctx} conversationId={selected} />
            </Suspense>
          </section>
        ) : null}
      </div>
    </>
  );
}

function ConversationItem({ c, active, href, now, snippet }: { c: ListRow; active: boolean; href: string; now: Date; snippet?: string }) {
  const channel = (CHANNEL_ICONS as Record<string, string>)[c.channel] ?? "✉";
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cx("block px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/60", active && "bg-brand-50 dark:bg-brand-800/30")}
    >
      <div className="flex items-center gap-2">
        {c.unread ? <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-brand-600" /> : <span className="h-2 w-2 shrink-0" />}
        <span title={(CHANNEL_LABELS as Record<string, string>)[c.channel]} className="w-4 shrink-0 text-center text-xs text-slate-500">
          {channel}
        </span>
        <span className={cx("min-w-0 flex-1 truncate", c.unread ? "font-semibold" : "font-medium")}>{c.guest_name ?? "Unknown"}</span>
        {c.awaiting_reply_since && c.status === "open" ? (
          <span className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400" title="Time since the guest's message">
            {timeSince(c.last_guest_message_at, now)}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-slate-400">{timeSince(c.last_message_at, now)}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-slate-500">
        {c.listing_name ? <span className="truncate">{c.listing_name}</span> : <span>No reservation</span>}
        {c.check_in && c.check_out ? (
          <span>
            {formatDate(c.check_in)} – {formatDate(c.check_out)}
          </span>
        ) : null}
        {c.reservation_status ? <Badge tone={c.reservation_status === "reserved" ? "amber" : c.reservation_status === "confirmed" ? "green" : "neutral"}>{STATUS_LABELS[c.reservation_status]}</Badge> : null}
        {c.status === "done" ? <Badge tone="green">Done</Badge> : null}
        {c.assignee_user_id ? (
          <span title={`Assigned to ${c.assignee_name ?? c.assignee_email}`} className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
            {initials(c.assignee_name ?? c.assignee_email)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 truncate pl-8 text-sm text-slate-600 dark:text-slate-300">
        {snippet ? <Snippet text={snippet} /> : (
          <>
            {c.last_message_kind === "outbound" ? <span className="text-slate-400">You: </span> : null}
            {c.last_message_preview ?? "No messages yet"}
          </>
        )}
      </p>
    </Link>
  );
}

/** ts_headline marks matches with [[…]]. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[\[[^\]]*\]\])/).map((part, i) =>
        part.startsWith("[[") ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 dark:bg-amber-900">
            {part.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
