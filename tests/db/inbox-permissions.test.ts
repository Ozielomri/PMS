/**
 * Inbox permissions per role, assignment (INB-08), notes (INB-09), read markers, saved replies
 * (INB-05), search (INB-14), the agent role and actor, and the agent approval queue (INB-11).
 */
import { describe, expect, it } from "vitest";

import { day } from "./calendar-fixtures";
import { addMember, asSystem, asUser, query } from "./helpers";
import { asService, emailPayload, eventsFor, inboxSetup, ingest, rpc, send } from "./inbox-fixtures";
import { book } from "./reservations-fixtures";

async function setupWithConversation() {
  const s = await inboxSetup();
  const res = await book(s.manager, s.listing, day(10), day(12), { guest: { first_name: "Ada", email: "ada@example.test" } });
  const convId = await rpc<string>(s.manager, "select public.inbox_open_conversation($1) as r", [res]);
  return { ...s, res, convId };
}

function propose(convId: string, requestedBy: string, content = "Hi Ada, check-in is from 4 PM.", actor = { type: "agent", id: "inbox-drafts" }) {
  return asService(
    async (db) =>
      (await db.query(
        "select public.agent_propose_reply($1, $2, $3, 'Check-in time from listing', 'high', false, '{\"listing\": [\"check_in_from\"]}'::jsonb, 'claude-opus-5-5', 1200, 80) as r",
        [convId, content, requestedBy],
      )).rows[0].r as string,
    actor,
  );
}

describe("roles", () => {
  it("lets front office reply, supervisors read only and cleaners see nothing", async () => {
    const s = await setupWithConversation();
    const fo = await addMember(s.accountId, "front_office");
    const supervisor = await addMember(s.accountId, "supervisor");
    const cleaner = await addMember(s.accountId, "cleaner");
    await send(fo, s.convId, "Hello from the front desk");
    const seen = await asUser(supervisor, async (db) => (await db.query("select count(*)::int as n from public.messages where conversation_id = $1", [s.convId])).rows[0].n);
    expect(seen).toBe(1);
    await expect(send(supervisor, s.convId, "Hi")).rejects.toThrow(/forbidden/);
    const cleanerSees = await asUser(cleaner, async (db) => (await db.query("select count(*)::int as n from public.conversations")).rows[0].n);
    expect(cleanerSees).toBe(0);
    await expect(send(cleaner, s.convId, "Hi")).rejects.toThrow(/conversation_not_found/);
  });

  it("follows the reservation's listing scope", async () => {
    const s = await setupWithConversation();
    const fo = await addMember(s.accountId, "front_office");
    await asUser(s.admin, (db) => db.query("select public.set_membership_listing_scope($1, 'restricted', $2)", [fo.membershipId, ["elsewhere"]]));
    const visible = await asUser(fo, async (db) => (await db.query("select id from public.inbox_conversation_list")).rows);
    expect(visible).toEqual([]);
    // A conversation without a reservation stays visible to every inbox member.
    const r = await ingest(emailPayload({ account_token: s.token, from_email: "stranger@example.test" }));
    const after = await asUser(fo, async (db) => (await db.query("select id from public.inbox_conversation_list")).rows.map((x) => x.id));
    expect(after).toEqual([r.conversation_id]);
  });

  it("assigns: self with inbox.reply, others with inbox.manage, team members only (INB-08)", async () => {
    const s = await setupWithConversation();
    const fo = await addMember(s.accountId, "front_office");
    const cleaner = await addMember(s.accountId, "cleaner");
    await rpc(fo, "select public.inbox_assign($1, $2) as r", [s.convId, fo.id]);
    await rpc(s.manager, "select public.inbox_assign($1, $2) as r", [s.convId, s.manager.id]);
    await expect(rpc(s.manager, "select public.inbox_assign($1, $2) as r", [s.convId, cleaner.id])).rejects.toThrow(/not_a_member/);
    const list = await asUser(s.manager, async (db) => (await db.query("select assignee_user_id, guest_name, reservation_code from public.inbox_conversation_list where id = $1", [s.convId])).rows[0]);
    expect(list.assignee_user_id).toBe(s.manager.id);
    expect(list.guest_name).toBe("Ada");
    const ev = await eventsFor(s.convId);
    expect(ev.filter((e) => e.type === "conversation.updated")).toHaveLength(2);
  });

  it("keeps notes internal, with mentions limited to the team (INB-09)", async () => {
    const s = await setupWithConversation();
    const outsider = await inboxSetup();
    const id = await rpc<string>(s.manager, "select public.inbox_add_note($1, 'Check the deposit', $2) as r", [s.convId, [s.admin.id, outsider.admin.id]]);
    const [m] = await query("select kind, channel, mentions from public.messages where id = $1", [id]);
    expect(m).toEqual({ kind: "note", channel: "internal", mentions: [s.admin.id] });
    expect(await query("select 1 from public.message_deliveries where message_id = $1", [id])).toHaveLength(0);
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["message.note_added"]);
  });

  it("tracks unread per user", async () => {
    const s = await setupWithConversation();
    await ingest(emailPayload({ account_token: s.token, from_email: "ada@example.test" }));
    const unread = (u: { id: string }) => asUser(u, async (db) => (await db.query("select unread from public.inbox_conversation_list where id = $1", [s.convId])).rows[0].unread);
    expect(await unread(s.manager)).toBe(true);
    await rpc(s.manager, "select public.inbox_mark_read($1) as r", [s.convId]);
    expect(await unread(s.manager)).toBe(false);
    expect(await unread(s.admin)).toBe(true);
  });

  it("does not let clients write inbox tables directly", async () => {
    const s = await setupWithConversation();
    await expect(asUser(s.admin, (db) => db.query("update public.conversations set status = 'done' where id = $1", [s.convId]))).rejects.toThrow(/permission denied/);
    await expect(
      asUser(s.admin, (db) =>
        db.query("insert into public.messages (account_id, conversation_id, kind, channel, author_type, body) values ($1, $2, 'inbound', 'email', 'guest', 'x')", [s.accountId, s.convId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("saved replies (INB-05)", () => {
  it("are managed with inbox.manage and validate variants", async () => {
    const s = await inboxSetup();
    const supervisor = await addMember(s.accountId, "supervisor");
    await asUser(s.manager, (db) =>
      db.query("insert into public.saved_replies (account_id, title, shortcut, body, variants) values ($1, 'Check-in', 'CheckIn', 'Hi {{guest.first_name}}', $2)", [
        s.accountId,
        JSON.stringify({ es: "Hola {{guest.first_name}}" }),
      ]),
    );
    const [row] = await query<{ id: string; shortcut: string }>("select id, shortcut from public.saved_replies where account_id = $1", [s.accountId]);
    expect(row.shortcut).toBe("checkin");
    await expect(
      asUser(s.manager, (db) => db.query("insert into public.saved_replies (account_id, title, body, variants) values ($1, 'X', 'Y', '{\"english\": \"z\"}')", [s.accountId])),
    ).rejects.toThrow(/invalid_variants/);
    await expect(asUser(supervisor, (db) => db.query("insert into public.saved_replies (account_id, title, body) values ($1, 'X', 'Y')", [s.accountId]))).rejects.toThrow(
      /row-level security/,
    );
    const visible = await asUser(supervisor, async (db) => (await db.query("select count(*)::int as n from public.saved_replies")).rows[0].n);
    expect(visible).toBe(1);
    expect((await eventsFor(row.id)).map((e) => e.type)).toEqual(["saved_reply.created"]);
  });
});

describe("search (INB-14)", () => {
  it("finds messages by words, within the caller's account", async () => {
    const s = await setupWithConversation();
    await ingest(emailPayload({ account_token: s.token, from_email: "ada@example.test", text: "Is there parking for two cars near the cottage?" }));
    const other = await inboxSetup();
    await ingest(emailPayload({ account_token: other.token, from_email: "x@example.test", text: "parking question" }));
    const rows = await asUser(s.manager, async (db) => (await db.query("select conversation_id, snippet from public.search_inbox($1, 'parking cars')", [s.accountId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe(s.convId);
    expect(rows[0].snippet).toContain("[[parking]]");
    const leak = await asUser(s.manager, async (db) => (await db.query("select count(*)::int as n from public.search_inbox($1, 'parking')", [other.accountId])).rows[0].n);
    expect(leak).toBe(0);
  });
});

describe("agent role and approval queue (INB-11, docs/plans/ai-agent.md)", () => {
  it("is not assignable to people", async () => {
    const s = await inboxSetup();
    await expect(addMember(s.accountId, "agent" as never)).rejects.toThrow(/memberships_not_agent/);
    await expect(asUser(s.admin, (db) => db.query("select * from public.create_invitation($1, 'bot@example.test', 'agent')", [s.accountId]))).rejects.toThrow(
      /invitations_not_agent/,
    );
  });

  it("stores a draft as the agent actor, never sends it, and supersedes older drafts", async () => {
    const s = await setupWithConversation();
    const first = await propose(s.convId, s.manager.id);
    const second = await propose(s.convId, s.manager.id, "Hi Ada! Check-in starts at 4 PM.");
    const rows = await query<{ id: string; status: string; tool_name: string; tool_input: Record<string, unknown> }>(
      "select id, status, tool_name, tool_input from public.agent_proposals where conversation_id = $1 order by created_at",
      [s.convId],
    );
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first, "superseded"],
      [second, "pending"],
    ]);
    expect(rows[1]).toMatchObject({ tool_name: "inbox_send_message", tool_input: { p_conversation_id: s.convId, p_body: "Hi Ada! Check-in starts at 4 PM." } });
    expect(await query("select 1 from public.messages where conversation_id = $1 and kind = 'outbound'", [s.convId])).toHaveLength(0);
    const [audit] = await query("select actor_type, actor_id from public.audit_log where entity_type = 'agent_proposals' and entity_id = $1 and action = 'insert'", [second]);
    expect(audit).toEqual({ actor_type: "agent", actor_id: "inbox-drafts" });
    expect((await eventsFor(second)).map((e) => [e.type, e.actor_type])).toEqual([["agent_proposal.created", "agent"]]);

    // A human sends it with an edit → "edited", linked to the message.
    const msg = await send(s.manager, s.convId, "Hi Ada! Check-in starts at 4 PM. See you!", { proposalId: second });
    const [p] = await query("select status, decided_by, message_id from public.agent_proposals where id = $1", [second]);
    expect(p).toEqual({ status: "edited", decided_by: s.manager.id, message_id: msg });
    await expect(send(s.manager, s.convId, "again", { proposalId: second })).rejects.toThrow(/proposal_not_pending/);
  });

  it("accepts an unchanged draft and lets a user reject one", async () => {
    const s = await setupWithConversation();
    const a = await propose(s.convId, s.manager.id, "Exactly this.");
    await send(s.manager, s.convId, "Exactly this.", { proposalId: a });
    expect((await query("select status from public.agent_proposals where id = $1", [a]))[0].status).toBe("accepted");
    const b = await propose(s.convId, s.manager.id);
    await rpc(s.manager, "select public.reject_agent_proposal($1) as r", [b]);
    expect((await query("select status from public.agent_proposals where id = $1", [b]))[0].status).toBe("rejected");
    await expect(asSystem((db) => db.query("update public.agent_proposals set content = 'x' where id = $1", [b]))).rejects.toThrow(/proposal_not_pending/);
  });

  it("refuses non-agent actors, requesters without inbox.reply and accounts with drafts switched off", async () => {
    const s = await setupWithConversation();
    const supervisor = await addMember(s.accountId, "supervisor");
    await expect(propose(s.convId, s.manager.id, "x", { type: "system", id: "cron" })).rejects.toThrow(/only the agent/);
    await expect(propose(s.convId, supervisor.id)).rejects.toThrow(/requesting user/);
    await expect(rpc(s.manager, "select public.agent_propose_reply($1, 'x', $2) as r", [s.convId, s.manager.id])).rejects.toThrow(/permission denied/);
    await asUser(s.admin, (db) => db.query("update public.inbox_settings set ai_drafts_enabled = false where account_id = $1", [s.accountId]));
    await expect(propose(s.convId, s.manager.id)).rejects.toThrow(/ai_drafts_disabled/);
  });

  it("checks the agent role's permissions from role_permissions", async () => {
    const check = (actor: string) =>
      asSystem(async (db) => {
        await db.query("select set_config('pms.actor_type', $1, true)", [actor]);
        return (await db.query("select private.agent_has_permission('inbox.reply') as reply, private.agent_has_permission('reservations.cancel') as cancel")).rows[0];
      });
    expect(await check("agent")).toEqual({ reply: true, cancel: false });
    expect(await check("system")).toEqual({ reply: false, cancel: false });
  });
});
