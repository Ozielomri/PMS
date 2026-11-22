/**
 * INB-10 delivery status machine (parity with the TS mirror), the outbound queue (claim, lease,
 * record, retry, discard), provider delivery events, INB-06 unresolved variables, INB-13 response
 * time and INB-16 message.queued / message.sent.
 */
import { describe, expect, it } from "vitest";

import { DELIVERY_STATUSES, canDeliveryTransition } from "@/lib/inbox/delivery";

import { day } from "./calendar-fixtures";
import { asSystem, query } from "./helpers";
import { asService, delivery, emailPayload, eventsFor, inboxSetup, ingest, rpc, send } from "./inbox-fixtures";
import { book } from "./reservations-fixtures";

async function conversationWithGuest() {
  const s = await inboxSetup();
  const res = await book(s.manager, s.listing, day(10), day(12), { guest: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.test" } });
  const convId = await rpc<string>(s.manager, "select public.inbox_open_conversation($1) as r", [res]);
  return { ...s, res, convId };
}

function claim(limit = 10, accountId: string | null = null, lease = 60) {
  return asService(
    async (db) => (await db.query("select * from public.claim_outbound_messages($1, $2, $3)", [limit, lease, accountId])).rows,
    { type: "system", id: "inbox-outbox" },
  );
}

function record(messageId: string, outcome: string, extra: { providerId?: string; error?: string; retryAt?: string } = {}) {
  return asService(
    async (db) =>
      (await db.query("select public.record_outbound_result($1, $2, 'postmark', $3, $4, $5::timestamptz) as r", [
        messageId,
        outcome,
        extra.providerId ?? null,
        extra.error ?? null,
        extra.retryAt ?? null,
      ])).rows[0].r as boolean,
    { type: "system", id: "inbox-outbox" },
  );
}

describe("delivery transitions", () => {
  it("match the TypeScript mirror for every pair", async () => {
    const rows = await query<{ f: string; t: string; ok: boolean }>(
      "select f, t, private.delivery_transition_allowed(f, t) as ok from unnest($1::text[]) f cross join unnest($1::text[]) t",
      [DELIVERY_STATUSES],
    );
    for (const { f, t, ok } of rows) expect([f, t, ok]).toEqual([f, t, canDeliveryTransition(f as never, t as never)]);
  });

  it("refuses illegal changes in the table itself", async () => {
    const { manager, convId } = await conversationWithGuest();
    const id = await send(manager, convId, "Hello");
    await expect(asSystem((db) => db.query("update public.message_deliveries set status = 'delivered' where message_id = $1", [id]))).rejects.toThrow(
      /delivery_transition_invalid/,
    );
    await expect(asSystem((db) => db.query("delete from public.message_deliveries where message_id = $1", [id]))).rejects.toThrow(/never deleted/);
  });
});

describe("sending", () => {
  it("stores the reply and queues it; the conversation is answered and the response time recorded (INB-13)", async () => {
    const s = await conversationWithGuest();
    const r = await ingest(emailPayload({ account_token: s.token, from_email: "ada@example.test", text: "Early check-in?" }));
    expect(r.conversation_id).toBe(s.convId);
    await asSystem((db) => db.query("update public.conversations set awaiting_reply_since = now() - interval '10 minutes' where id = $1", [s.convId]));

    const id = await send(s.manager, s.convId, "Hi Ada, yes from 1 PM.", { template: "Hi {{guest.first_name}}, yes from 1 PM." });
    const [m] = await query("select kind, author_type, author_user_id, recipient_email, body_template, response_seconds from public.messages where id = $1", [id]);
    expect(m).toMatchObject({ kind: "outbound", author_type: "user", author_user_id: s.manager.id, recipient_email: "ada@example.test", body_template: "Hi {{guest.first_name}}, yes from 1 PM." });
    expect(m.response_seconds).toBeGreaterThanOrEqual(600);
    expect((await delivery(id)).status).toBe("queued");
    const [c] = await query("select awaiting_reply_since, last_message_kind from public.conversations where id = $1", [s.convId]);
    expect(c).toEqual({ awaiting_reply_since: null, last_message_kind: "outbound" });
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["message.queued"]);

    const stats = await rpc<number>(s.manager, "select avg_seconds as r from public.inbox_response_stats where author_user_id = $1", [s.manager.id]);
    expect(stats).toBeGreaterThanOrEqual(600);
  });

  it("refuses a body with an unresolved variable, in the RPC and in the table (INB-06)", async () => {
    const { manager, convId, accountId } = await conversationWithGuest();
    await expect(send(manager, convId, "Your code is {{custom.door_code}}")).rejects.toThrow(/unresolved_variables: custom.door_code/);
    await expect(
      asSystem((db) =>
        db.query(
          "insert into public.messages (account_id, conversation_id, kind, channel, author_type, body) values ($1, $2, 'outbound', 'email', 'system', 'Code {{ custom.door_code }}')",
          [accountId, convId],
        ),
      ),
    ).rejects.toThrow(/messages_no_unresolved_variables/);
    // Guests may write braces; notes too.
    await rpc(manager, "select public.inbox_add_note($1, 'Remember {{custom.door_code}}') as r", [convId]);
  });

  it("needs a recipient and an available channel", async () => {
    const s = await inboxSetup();
    const res = await book(s.manager, s.listing, day(10), day(12), { guest: { first_name: "NoMail" } });
    const convId = await rpc<string>(s.manager, "select public.inbox_open_conversation($1) as r", [res]);
    await expect(send(s.manager, convId, "Hi")).rejects.toThrow(/no_recipient/);
    const c2 = await conversationWithGuest();
    await expect(rpc(c2.manager, "select public.inbox_send_message($1, 'Hi', p_channel => 'booking_com') as r", [c2.convId])).rejects.toThrow(/channel_unavailable/);
  });
});

describe("outbound queue", () => {
  it("claims with a lease, records sent then delivered, and emits message.sent / message.delivered", async () => {
    const s = await conversationWithGuest();
    const id = await send(s.manager, s.convId, "Hello");
    const claimed = await claim(10, s.accountId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      message_id: id,
      attempts: 1,
      to_address: "ada@example.test",
      to_name: "Ada Lovelace",
      subject: "Your stay at Ocean Breeze",
      body: "Hello",
      rfc_message_id: `<${id}@pms>`,
      account_token: s.token,
    });
    expect(claimed[0].sender_name).toBe("Test Rentals");
    // Leased: a second worker gets nothing.
    expect(await claim(10, s.accountId)).toHaveLength(0);

    expect(await record(id, "sent", { providerId: "pm-1" })).toBe(true);
    expect(await delivery(id)).toMatchObject({ status: "sent", provider_message_id: "pm-1", locked_until: null });
    const changed = await asService((db) => db.query("select public.record_delivery_event('postmark', 'pm-1', 'delivered') as r"), { type: "channel", id: "email" });
    expect(changed.rows[0].r).toBe(true);
    expect((await delivery(id)).status).toBe("delivered");
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["message.queued", "message.sent", "message.delivered"]);
  });

  it("threads replies to the guest's last message", async () => {
    const s = await conversationWithGuest();
    await ingest(emailPayload({ account_token: s.token, from_email: "ada@example.test", rfc_message_id: "<guest-1@mail.example>" }));
    const id = await send(s.manager, s.convId, "Reply");
    const [row] = await claim(10, s.accountId);
    expect(row).toMatchObject({ message_id: id, in_reply_to: "<guest-1@mail.example>", thread_references: ["<guest-1@mail.example>"] });
  });

  it("retries, fails with a reason, and lets a user retry or discard (business rule: never edited or deleted)", async () => {
    const s = await conversationWithGuest();
    const id = await send(s.manager, s.convId, "Hello");
    await claim(10, s.accountId);
    const soon = new Date(Date.now() - 1000).toISOString();
    expect(await record(id, "retry", { error: "timeout", retryAt: soon })).toBe(true);
    expect(await delivery(id)).toMatchObject({ status: "queued", last_error: "timeout" });
    const again = await claim(10, s.accountId);
    expect(again[0].attempts).toBe(2);
    expect(await record(id, "failed", { error: "Postmark 406: Inactive recipient" })).toBe(true);
    expect(await delivery(id)).toMatchObject({ status: "failed", last_error: "Postmark 406: Inactive recipient" });
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["message.queued", "message.failed"]);
    // A late result from an old lease is ignored.
    expect(await record(id, "sent")).toBe(false);

    await rpc(s.manager, "select public.inbox_retry_message($1) as r", [id]);
    expect(await delivery(id)).toMatchObject({ status: "queued", attempts: 0, last_error: null });
    await claim(10, s.accountId);
    await record(id, "failed", { error: "again" });
    await rpc(s.manager, "select public.inbox_discard_message($1) as r", [id]);
    expect((await delivery(id)).status).toBe("discarded");
    await expect(rpc(s.manager, "select public.inbox_retry_message($1) as r", [id])).rejects.toThrow(/delivery_transition_invalid/);
    const [{ n }] = await query<{ n: number }>("select count(*)::int as n from public.messages where id = $1", [id]);
    expect(n).toBe(1);
  });

  it("takes over an expired lease", async () => {
    const s = await conversationWithGuest();
    const id = await send(s.manager, s.convId, "Hello");
    await claim(10, s.accountId);
    await asSystem((db) => db.query("update public.message_deliveries set locked_until = now() - interval '1 second' where message_id = $1", [id]));
    const again = await claim(10, s.accountId);
    expect(again.map((r) => [r.message_id, r.attempts])).toEqual([[id, 2]]);
  });

  it("is reserved for the service role", async () => {
    const s = await conversationWithGuest();
    for (const sql of [
      "select * from public.claim_outbound_messages()",
      "select public.record_outbound_result(gen_random_uuid(), 'sent')",
      "select public.record_delivery_event('postmark', 'x', 'delivered')",
      "select public.ingest_inbound_email('test', '{}'::jsonb)",
    ]) {
      await expect(rpc(s.admin, sql)).rejects.toThrow(/permission denied/);
    }
  });
});
