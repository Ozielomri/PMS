/**
 * INB-02 threading and inbound matching, the "stored even if unknown, matched later" rule,
 * INB-08 done → reopen, append-only messages and INB-16 message.received.
 */
import { describe, expect, it } from "vitest";

import { day } from "./calendar-fixtures";
import { query } from "./helpers";
import { conversation, emailPayload, eventsFor, inboxSetup, ingest, rpc, send } from "./inbox-fixtures";
import { book } from "./reservations-fixtures";

describe("inbound matching", () => {
  it("threads a reply by the reply token in the address, then the subject", async () => {
    const s = await inboxSetup();
    const res = await book(s.manager, s.listing, day(10), day(13), { guest: { first_name: "Ada", last_name: "L", email: "ada@example.test" } });
    const convId = await rpc<string>(s.manager, "select public.inbox_open_conversation($1) as r", [res]);
    const c = await conversation(convId);
    expect(c.reservation_id).toBe(res);
    expect(c.subject).toBe("Your stay at Ocean Breeze");

    const viaAddress = await ingest(emailPayload({ account_token: s.token, reply_token: c.reply_token, reply_token_source: "address", from_email: "other@elsewhere.test" }));
    expect(viaAddress).toMatchObject({ status: "matched", match_method: "reply_token_address", conversation_id: convId, duplicate: false });
    const viaSubject = await ingest(emailPayload({ account_token: null, reply_token: c.reply_token, reply_token_source: "subject" }));
    expect(viaSubject).toMatchObject({ match_method: "reply_token_subject", conversation_id: convId });
  });

  it("threads by In-Reply-To / References when the token is gone", async () => {
    const s = await inboxSetup();
    const res = await book(s.manager, s.listing, day(10), day(12), { guest: { first_name: "Bo", email: "bo@example.test" } });
    const convId = await rpc<string>(s.manager, "select public.inbox_open_conversation($1) as r", [res]);
    const msgId = await send(s.manager, convId, "Welcome!");
    const [{ rfc_message_id }] = await query<{ rfc_message_id: string }>("select rfc_message_id from public.messages where id = $1", [msgId]);
    expect(rfc_message_id).toBe(`<${msgId}@pms>`);
    const r = await ingest(emailPayload({ account_token: s.token, from_email: "forwarder@else.test", thread_ids: ["<unknown@x>", rfc_message_id] }));
    expect(r).toMatchObject({ match_method: "thread_header", conversation_id: convId });
  });

  it("matches a known guest by email to their current reservation", async () => {
    const s = await inboxSetup();
    await book(s.manager, s.listing, day(-20), day(-17), { guest: { first_name: "Cy", email: "cy@example.test" } });
    const [{ guest_id }] = await query<{ guest_id: string }>("select guest_id from public.reservations where account_id = $1", [s.accountId]);
    const next = await book(s.manager, s.listing, day(5), day(8), { guestId: guest_id });
    const r = await ingest(emailPayload({ account_token: s.token, from_email: "CY@example.test" }));
    expect(r.match_method).toBe("guest_email");
    expect((await conversation(r.conversation_id!)).reservation_id).toBe(next);
    // The next email of the same guest lands in the same conversation.
    const again = await ingest(emailPayload({ account_token: s.token, from_email: "cy@example.test" }));
    expect(again.conversation_id).toBe(r.conversation_id);
  });

  it("starts a contact conversation for an unknown sender and attaches it when the booking is created (INB-02)", async () => {
    const s = await inboxSetup();
    const first = await ingest(emailPayload({ account_token: s.token, from_email: "newguest@example.test", subject: "Availability?" }));
    expect(first).toMatchObject({ status: "matched", match_method: "new_conversation" });
    const second = await ingest(emailPayload({ account_token: s.token, from_email: "newguest@example.test" }));
    expect(second).toMatchObject({ match_method: "contact_email", conversation_id: first.conversation_id });
    const before = await conversation(first.conversation_id!);
    expect(before).toMatchObject({ reservation_id: null, guest_id: null, contact_email: "newguest@example.test", subject: "Availability?" });

    const res = await book(s.manager, s.listing, day(30), day(33), { status: "inquiry", guest: { first_name: "New", email: "newguest@example.test" } });
    const after = await conversation(first.conversation_id!);
    expect(after.reservation_id).toBe(res);
    expect(after.guest_id).not.toBeNull();
    // Opening the reservation's conversation finds the attached one; confirming the inquiry keeps it.
    expect(await rpc(s.manager, "select public.inbox_open_conversation($1) as r", [res])).toBe(first.conversation_id);
    await rpc(s.manager, "select public.confirm_reservation($1) as r", [res]);
    expect((await conversation(first.conversation_id!)).reservation_id).toBe(res);
  });

  it("stores email for an unknown account unmatched, and is idempotent per provider id", async () => {
    const payload = emailPayload({ account_token: "zzzzzzzzzz", from_email: "lost@example.test" });
    const r = await ingest(payload);
    expect(r).toMatchObject({ status: "unmatched", conversation_id: null, message_id: null });
    const [row] = await query("select account_id, status, from_email from public.inbound_emails where id = $1", [r.inbound_email_id]);
    expect(row).toEqual({ account_id: null, status: "unmatched", from_email: "lost@example.test" });
    const again = await ingest(payload);
    expect(again).toMatchObject({ inbound_email_id: r.inbound_email_id, duplicate: true });
  });

  it("does not create duplicates when the provider retries concurrently", async () => {
    const s = await inboxSetup();
    const payload = emailPayload({ account_token: s.token, from_email: "burst@example.test" });
    const results = await Promise.all([ingest(payload), ingest(payload), ingest(payload)]);
    expect(new Set(results.map((r) => r.message_id)).size).toBe(1);
    const [{ n }] = await query<{ n: number }>("select count(*)::int as n from public.messages m join public.conversations c on c.id = m.conversation_id where c.contact_email = 'burst@example.test' and c.account_id = $1", [s.accountId]);
    expect(n).toBe(1);
    // Different emails from one new sender at once still open one conversation.
    const many = await Promise.all([1, 2, 3].map(() => ingest(emailPayload({ account_token: s.token, from_email: "storm@example.test" }))));
    expect(new Set(many.map((r) => r.conversation_id)).size).toBe(1);
  });

  it("emits message.received as the channel actor and reopens a Done conversation (INB-08)", async () => {
    const s = await inboxSetup();
    const r = await ingest(emailPayload({ account_token: s.token, from_email: "dora@example.test", text: "Hi!" }));
    const events = await eventsFor(r.message_id!);
    expect(events.map((e) => [e.type, e.actor_type])).toEqual([["message.received", "channel"]]);
    expect(events[0].payload).toMatchObject({ message: { body: "Hi!", kind: "inbound" }, conversation: { id: r.conversation_id } });

    const c = await conversation(r.conversation_id!);
    expect(c.awaiting_reply_since).not.toBeNull();
    await rpc(s.manager, "select public.inbox_set_status($1, 'done') as r", [r.conversation_id]);
    expect((await conversation(r.conversation_id!)).status).toBe("done");
    await ingest(emailPayload({ account_token: s.token, reply_token: c.reply_token, from_email: "dora@example.test" }));
    expect((await conversation(r.conversation_id!)).status).toBe("open");
    const convEvents = await eventsFor(r.conversation_id!);
    expect(convEvents.map((e) => e.type)).toEqual(["conversation.created", "conversation.updated", "conversation.updated"]);
  });
});

describe("messages are append-only", () => {
  it("refuses updates and deletes, even for the owner", async () => {
    const s = await inboxSetup();
    const r = await ingest(emailPayload({ account_token: s.token }));
    await expect(query("update public.messages set body = 'changed' where id = $1", [r.message_id])).rejects.toThrow(/append-only/);
    await expect(query("delete from public.messages where id = $1", [r.message_id])).rejects.toThrow(/append-only/);
    await expect(query("delete from public.conversations where id = $1", [r.conversation_id])).rejects.toThrow(/never deleted/);
  });

  it("audits every message", async () => {
    const s = await inboxSetup();
    const r = await ingest(emailPayload({ account_token: s.token }));
    const rows = await query("select entity_type, action, actor_type from public.audit_log where entity_id = $1", [r.message_id]);
    expect(rows).toEqual([{ entity_type: "messages", action: "insert", actor_type: "channel" }]);
  });
});
