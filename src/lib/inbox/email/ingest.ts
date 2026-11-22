/**
 * Inbound email → public.ingest_inbound_email (service role). The SQL function threads the
 * message (reply token, thread headers, guest email, contact email, else a new conversation),
 * stores it even when no account matches, and is idempotent per provider message id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { extractTokens, normalizeSubject } from "@/lib/inbox/email/parse";
import type { NormalizedInbound } from "@/lib/inbox/email/provider";

export interface IngestPayload {
  provider_message_id: string;
  account_token: string | null;
  reply_token: string | null;
  reply_token_source: "address" | "subject" | null;
  from_email: string;
  from_name: string | null;
  to: string[];
  subject: string | null;
  raw_subject: string | null;
  text: string;
  rfc_message_id: string | null;
  thread_ids: string[];
  attachments: { name: string; content_type: string; size: number }[];
}

export function toIngestPayload(inbound: NormalizedInbound, inboundDomain: string): IngestPayload {
  const tokens = extractTokens(inbound.recipients, inbound.subject, inboundDomain);
  const threadIds = [...new Set([inbound.inReplyTo, ...[...inbound.references].reverse()].filter((v): v is string => Boolean(v)))];
  return {
    provider_message_id: inbound.providerMessageId,
    account_token: tokens.accountToken,
    reply_token: tokens.replyToken,
    reply_token_source: tokens.replyTokenSource,
    from_email: inbound.from.email,
    from_name: inbound.from.name,
    to: [...new Set(inbound.recipients.map((r) => r.trim().toLowerCase()))].slice(0, 50),
    subject: normalizeSubject(inbound.subject) || null,
    raw_subject: inbound.subject,
    text: inbound.text.slice(0, 20000),
    rfc_message_id: inbound.rfcMessageId,
    thread_ids: threadIds.slice(0, 50),
    attachments: inbound.attachments.slice(0, 20).map((a) => ({ name: a.name.slice(0, 200), content_type: a.contentType.slice(0, 100), size: a.size })),
  };
}

export interface IngestResult {
  inbound_email_id: string;
  status: "matched" | "unmatched";
  match_method: string | null;
  conversation_id: string | null;
  message_id: string | null;
  duplicate: boolean;
}

export async function ingestInboundEmail(client: SupabaseClient, provider: string, inbound: NormalizedInbound, inboundDomain: string): Promise<IngestResult> {
  const { data, error } = await client.rpc("ingest_inbound_email", { p_provider: provider, p_payload: toIngestPayload(inbound, inboundDomain) });
  if (error) throw new Error(`ingest_inbound_email: ${error.message}`);
  return data as IngestResult;
}
