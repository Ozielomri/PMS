/** INB-03 tabs and filters of the inbox list, kept in the URL. */
import { isChannel, type Channel } from "@/lib/inbox/channels";

export const INBOX_TABS = [
  ["unanswered", "Unanswered"],
  ["mine", "Assigned to me"],
  ["unassigned", "Unassigned"],
  ["pending", "Pending approval"],
  ["arriving", "Arriving in 48 h"],
  ["in_house", "In house"],
  ["done", "Done"],
  ["all", "All"],
] as const;
export type InboxTab = (typeof INBOX_TABS)[number][0];

export interface InboxFilters {
  tab: InboxTab;
  channel: Channel | "";
  listing: string;
  tag: string;
  q: string;
  /** Selected conversation id. */
  conversation: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function parseInboxFilters(sp: Record<string, string | string[] | undefined>): InboxFilters {
  const tab = one(sp.tab);
  const channel = one(sp.channel);
  const listing = one(sp.listing);
  const conversation = one(sp.c);
  return {
    tab: (INBOX_TABS.map((t) => t[0]) as string[]).includes(tab) ? (tab as InboxTab) : "unanswered",
    channel: isChannel(channel) ? channel : "",
    listing: UUID.test(listing) ? listing : "",
    tag: one(sp.tag).trim().slice(0, 50),
    q: one(sp.q).trim().slice(0, 200),
    conversation: UUID.test(conversation) ? conversation : "",
  };
}

export function inboxFiltersToQuery(f: InboxFilters, overrides: Partial<InboxFilters> = {}): string {
  const merged = { ...f, ...overrides };
  const p = new URLSearchParams();
  if (merged.tab !== "unanswered") p.set("tab", merged.tab);
  if (merged.channel) p.set("channel", merged.channel);
  if (merged.listing) p.set("listing", merged.listing);
  if (merged.tag) p.set("tag", merged.tag);
  if (merged.q) p.set("q", merged.q);
  if (merged.conversation) p.set("c", merged.conversation);
  return p.toString();
}
