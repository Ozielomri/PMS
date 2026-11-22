/** Shared helpers for the inbox DB tests (tests/db/inbox-*.test.ts). */
import { randomUUID } from "node:crypto";

import { createListing } from "./calendar-fixtures";
import { as, addMember, asUser, createAccount, query, type Db } from "./helpers";

type User = { id: string; email?: string };

export async function inboxSetup() {
  const { accountId, admin } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const listing = await createListing(accountId, { public_title: "Ocean Breeze" });
  const [s] = await query<{ inbound_token: string }>("select inbound_token from public.inbox_settings where account_id = $1", [accountId]);
  return { accountId, admin, manager, listing, token: s.inbound_token };
}

/** As the service role with an actor (default: the email channel). */
export function asService<T>(fn: (db: Db) => Promise<T>, actor: { type: string; id?: string } = { type: "channel", id: "email" }) {
  return as({ role: "service_role", headers: { "x-pms-actor-type": actor.type, ...(actor.id ? { "x-pms-actor-id": actor.id } : {}) } }, fn);
}

export interface IngestResult {
  inbound_email_id: string;
  status: string;
  match_method: string | null;
  conversation_id: string | null;
  message_id: string | null;
  duplicate: boolean;
}

export function emailPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider_message_id: randomUUID(),
    account_token: null,
    reply_token: null,
    reply_token_source: null,
    from_email: "ada@example.test",
    from_name: "Ada Lovelace",
    to: [],
    subject: "Question",
    raw_subject: "Question",
    text: "Hello there",
    rfc_message_id: `<${randomUUID()}@mail.example>`,
    thread_ids: [],
    attachments: [],
    ...overrides,
  };
}

export async function ingest(payload: Record<string, unknown>, provider = "test"): Promise<IngestResult> {
  return asService(async (db) => (await db.query("select public.ingest_inbound_email($1, $2::jsonb) as r", [provider, JSON.stringify(payload)])).rows[0].r);
}

export async function conversation(id: string) {
  const [row] = await query<Record<string, unknown> & { status: string; reservation_id: string | null; guest_id: string | null; awaiting_reply_since: Date | null; reply_token: string }>(
    "select * from public.conversations where id = $1",
    [id],
  );
  return row;
}

export async function rpc<T = unknown>(user: User, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(user, async (db) => (await db.query(sql, params)).rows[0]?.r as T);
}

/** Sends a reply as `user` and returns the message id. */
export function send(user: User, conversationId: string, body: string, extra: { template?: string; proposalId?: string } = {}) {
  return rpc<string>(user, "select public.inbox_send_message($1, $2, $3, null, $4) as r", [conversationId, body, extra.template ?? null, extra.proposalId ?? null]);
}

export async function delivery(messageId: string) {
  const [row] = await query<{ status: string; attempts: number; last_error: string | null; provider_message_id: string | null; next_attempt_at: Date; locked_until: Date | null }>(
    "select * from public.message_deliveries where message_id = $1",
    [messageId],
  );
  return row;
}

export async function eventsFor(entityId: string) {
  return (await query<{ type: string; actor_type: string; payload: Record<string, unknown> }>(
    "select type, actor_type, payload from public.domain_events where entity_id = $1 order by seq",
    [entityId],
  ));
}
