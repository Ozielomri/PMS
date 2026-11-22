/**
 * INB-10 outbound queue worker. public.claim_outbound_messages() hands out queued messages with a
 * lease (FOR UPDATE SKIP LOCKED), this sends them through the email adapter and records the
 * outcome; transient failures retry with exponential backoff (src/lib/retry), permanent ones and
 * the last attempt fail with the reason. Overlapping runs are safe: a message is only recorded
 * while it is still `sending` under the lease of the run that claimed it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildOutboundEmail, type ClaimedMessage, type EmailConfig } from "@/lib/inbox/email/compose";
import { EmailSendError, type EmailProvider } from "@/lib/inbox/email/provider";
import { nextRetryAt } from "@/lib/retry/backoff";

export interface ClaimedOutbound extends ClaimedMessage {
  accountId: string;
  attempts: number;
}

export interface OutboxResult {
  outcome: "sent" | "delivered" | "retry" | "failed";
  provider: string;
  providerMessageId: string | null;
  error: string | null;
  retryAt: Date | null;
}

export interface OutboxStore {
  claim(limit: number, leaseSeconds: number, accountId?: string | null): Promise<ClaimedOutbound[]>;
  record(messageId: string, result: OutboxResult): Promise<void>;
}

export const OUTBOX_BACKOFF = { baseDelayMs: 30_000, maxDelayMs: 30 * 60_000, jitter: 0.2 } as const;
export const OUTBOX_MAX_ATTEMPTS = 6;

export interface OutboxSummary {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

export async function processOutbox(opts: {
  store: OutboxStore;
  provider: EmailProvider;
  config: EmailConfig;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  accountId?: string | null;
  now?: () => Date;
  random?: () => number;
}): Promise<OutboxSummary> {
  const now = opts.now ?? (() => new Date());
  const items = await opts.store.claim(opts.limit ?? 50, opts.leaseSeconds ?? 60, opts.accountId ?? undefined);
  const summary: OutboxSummary = { claimed: items.length, sent: 0, retrying: 0, failed: 0 };
  for (const item of items) {
    try {
      const res = await opts.provider.send(buildOutboundEmail(item, opts.config));
      await opts.store.record(item.messageId, {
        outcome: res.delivered ? "delivered" : "sent",
        provider: opts.provider.name,
        providerMessageId: res.providerMessageId,
        error: null,
        retryAt: null,
      });
      summary.sent++;
    } catch (err) {
      const message = ((err as Error)?.message ?? String(err)).slice(0, 1000);
      const permanent = err instanceof EmailSendError && err.permanent;
      const retryAt = permanent
        ? null
        : nextRetryAt({ attempt: item.attempts, now: now(), maxAttempts: opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS, random: opts.random, ...OUTBOX_BACKOFF });
      await opts.store.record(item.messageId, { outcome: retryAt ? "retry" : "failed", provider: opts.provider.name, providerMessageId: null, error: message, retryAt });
      if (retryAt) summary.retrying++;
      else summary.failed++;
    }
  }
  return summary;
}

interface ClaimRow {
  message_id: string;
  account_id: string;
  attempts: number;
  to_address: string;
  to_name: string | null;
  subject: string | null;
  body: string;
  rfc_message_id: string;
  in_reply_to: string | null;
  thread_references: string[] | null;
  reply_token: string;
  account_token: string;
  sender_name: string;
}

/** OutboxStore backed by the service-role RPCs of migration 20261125001200. */
export function supabaseOutboxStore(client: SupabaseClient): OutboxStore {
  return {
    async claim(limit, leaseSeconds, accountId) {
      const { data, error } = await client.rpc("claim_outbound_messages", { p_limit: limit, p_lease_seconds: leaseSeconds, p_account_id: accountId ?? null });
      if (error) throw new Error(`claim_outbound_messages: ${error.message}`);
      return ((data ?? []) as ClaimRow[]).map((r) => ({
        messageId: r.message_id,
        accountId: r.account_id,
        attempts: r.attempts,
        toAddress: r.to_address,
        toName: r.to_name,
        subject: r.subject,
        body: r.body,
        rfcMessageId: r.rfc_message_id,
        inReplyTo: r.in_reply_to,
        references: r.thread_references ?? [],
        replyToken: r.reply_token,
        accountToken: r.account_token,
        senderName: r.sender_name,
      }));
    },
    async record(messageId, result) {
      const { error } = await client.rpc("record_outbound_result", {
        p_message_id: messageId,
        p_outcome: result.outcome,
        p_provider: result.provider,
        p_provider_message_id: result.providerMessageId,
        p_error: result.error,
        p_retry_at: result.retryAt?.toISOString() ?? null,
      });
      if (error) throw new Error(`record_outbound_result: ${error.message}`);
    },
  };
}
