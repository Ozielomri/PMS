import { describe, expect, it, vi } from "vitest";

import { signatureHeader } from "@/lib/webhooks/signature";
import { toIngestPayload } from "@/lib/inbox/email/ingest";
import { logProvider } from "@/lib/inbox/email/log";
import { postmarkProvider } from "@/lib/inbox/email/postmark";
import { EmailSendError } from "@/lib/inbox/email/provider";
import { isAuthorizedInboxWebhook } from "@/lib/inbox/email/webhook-auth";
import { OUTBOX_MAX_ATTEMPTS, processOutbox, type ClaimedOutbound, type OutboxResult, type OutboxStore } from "@/lib/inbox/outbox";

const CONFIG = { fromAddress: "stays@mail.pms.example", inboundDomain: "in.pms.example" };

const POSTMARK_INBOUND = {
  FromFull: { Email: "Ada@Example.com", Name: "Ada Lovelace" },
  ToFull: [{ Email: "k3j9x2m8qa+ab12cd34ef@in.pms.example", Name: "" }],
  CcFull: [{ Email: "friend@example.com", Name: "Friend" }],
  OriginalRecipient: "k3j9x2m8qa+ab12cd34ef@in.pms.example",
  Subject: "Re: Your stay [#ab12cd34ef]",
  MessageID: "pm-inbound-1",
  TextBody: "Can we check in early?\n\nOn Mon, Nov 23, 2026 at 10:00 AM Sunny <x@y.com> wrote:\n> Hello",
  StrippedTextReply: "Can we check in early?",
  Headers: [
    { Name: "Message-ID", Value: "<CAF123@mail.gmail.com>" },
    { Name: "In-Reply-To", Value: "<m1@pms>" },
    { Name: "References", Value: "<m0@pms> <m1@pms>" },
  ],
  Attachments: [{ Name: "id.pdf", ContentType: "application/pdf", ContentLength: 1234, Content: "base64…" }],
  Date: "Mon, 23 Nov 2026 12:00:00 +0000",
};

describe("Postmark adapter", () => {
  it("normalizes an inbound email (reply part, headers, attachment metadata only)", () => {
    const inbound = postmarkProvider({ serverToken: "t" }).parseInbound(POSTMARK_INBOUND);
    expect(inbound).toEqual({
      providerMessageId: "pm-inbound-1",
      from: { email: "ada@example.com", name: "Ada Lovelace" },
      recipients: ["k3j9x2m8qa+ab12cd34ef@in.pms.example", "friend@example.com", "k3j9x2m8qa+ab12cd34ef@in.pms.example"],
      subject: "Re: Your stay [#ab12cd34ef]",
      text: "Can we check in early?",
      rfcMessageId: "<CAF123@mail.gmail.com>",
      inReplyTo: "<m1@pms>",
      references: ["<m0@pms>", "<m1@pms>"],
      attachments: [{ name: "id.pdf", contentType: "application/pdf", size: 1234 }],
    });
  });

  it("rejects payloads without a sender or id", () => {
    expect(() => postmarkProvider({ serverToken: "t" }).parseInbound({ Subject: "x" })).toThrow(/invalid inbound/);
  });

  it("sends through the HTTP API with our headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-out-1" }), { status: 200 }));
    const provider = postmarkProvider({ serverToken: "server-token", fetch: fetchMock });
    const result = await provider.send({
      from: '"Sunny" <stays@mail.pms.example>',
      to: "ada@example.com",
      replyTo: "k3j9x2m8qa+ab12cd34ef@in.pms.example",
      subject: "Re: Hi [#ab12cd34ef]",
      text: "Yes, from 1 PM.",
      headers: { "Message-ID": "<m2@pms>", "In-Reply-To": "<CAF123@mail.gmail.com>" },
      tag: "m2",
    });
    expect(result).toEqual({ providerMessageId: "pm-out-1", delivered: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.headers["X-Postmark-Server-Token"]).toBe("server-token");
    expect(JSON.parse(init.body)).toMatchObject({
      From: '"Sunny" <stays@mail.pms.example>',
      To: "ada@example.com",
      ReplyTo: "k3j9x2m8qa+ab12cd34ef@in.pms.example",
      TextBody: "Yes, from 1 PM.",
      Headers: [
        { Name: "Message-ID", Value: "<m2@pms>" },
        { Name: "In-Reply-To", Value: "<CAF123@mail.gmail.com>" },
      ],
      Metadata: { pms_message_id: "m2" },
      MessageStream: "outbound",
    });
  });

  it("classifies errors: invalid recipient is permanent, 5xx is transient", async () => {
    const bad = postmarkProvider({
      serverToken: "t",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient" }), { status: 422 })),
    });
    await expect(bad.send({ from: "a", to: "b", replyTo: "c", subject: "d", text: "e", headers: {}, tag: "x" })).rejects.toMatchObject({
      permanent: true,
      message: "Postmark 406: Inactive recipient",
    });
    const down = postmarkProvider({ serverToken: "t", fetch: vi.fn().mockResolvedValue(new Response("oops", { status: 503 })) });
    await expect(down.send({ from: "a", to: "b", replyTo: "c", subject: "d", text: "e", headers: {}, tag: "x" })).rejects.toMatchObject({ permanent: false });
  });

  it("maps delivery and bounce webhooks", () => {
    const p = postmarkProvider({ serverToken: "t" });
    expect(p.parseEvent({ RecordType: "Delivery", MessageID: "pm-out-1" })).toEqual({ providerMessageId: "pm-out-1", status: "delivered", reason: null });
    expect(p.parseEvent({ RecordType: "Bounce", MessageID: "pm-out-1", Type: "HardBounce", Description: "Mailbox does not exist" })).toEqual({
      providerMessageId: "pm-out-1",
      status: "failed",
      reason: "HardBounce: Mailbox does not exist",
    });
    expect(p.parseEvent({ RecordType: "Open", MessageID: "x" })).toBeNull();
  });
});

describe("log adapter (development)", () => {
  it("accepts the generic JSON format and reports sends as delivered without network", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const p = logProvider();
    expect(await p.send({ from: "a", to: "b@c.d", replyTo: "r", subject: "s", text: "secret door code", headers: {}, tag: "m9" })).toEqual({
      providerMessageId: "log-m9",
      delivered: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret door code");
    info.mockRestore();
    expect(
      p.parseInbound({ message_id: "g1", from: "Bob <bob@x.com>", to: ["acc@in.d"], subject: "Hi", text: "Hello\n> old", in_reply_to: "<m1@pms>" }),
    ).toEqual({
      providerMessageId: "g1",
      from: { email: "bob@x.com", name: "Bob" },
      recipients: ["acc@in.d"],
      subject: "Hi",
      text: "Hello",
      rfcMessageId: null,
      inReplyTo: "<m1@pms>",
      references: [],
      attachments: [],
    });
  });
});

describe("inbound webhook auth", () => {
  const secret = "s3cret-value";
  it("accepts bearer, basic (password = secret) and an HMAC signature", () => {
    expect(isAuthorizedInboxWebhook({ authorization: `Bearer ${secret}`, signature: null, body: "{}", secret })).toBe(true);
    const basic = `Basic ${Buffer.from(`postmark:${secret}`).toString("base64")}`;
    expect(isAuthorizedInboxWebhook({ authorization: basic, signature: null, body: "{}", secret })).toBe(true);
    expect(isAuthorizedInboxWebhook({ authorization: null, signature: signatureHeader(secret, '{"a":1}'), body: '{"a":1}', secret })).toBe(true);
  });

  it("rejects everything else, and always without a secret", () => {
    expect(isAuthorizedInboxWebhook({ authorization: "Bearer nope", signature: null, body: "{}", secret })).toBe(false);
    expect(isAuthorizedInboxWebhook({ authorization: null, signature: signatureHeader(secret, "{}"), body: '{"x":1}', secret })).toBe(false);
    expect(isAuthorizedInboxWebhook({ authorization: `Basic ${Buffer.from("u:wrong").toString("base64")}`, signature: null, body: "", secret })).toBe(false);
    expect(isAuthorizedInboxWebhook({ authorization: "Bearer ", signature: null, body: "", secret: "" })).toBe(false);
  });
});

describe("ingest payload", () => {
  it("adds routing tokens and a normalized subject", () => {
    const inbound = postmarkProvider({ serverToken: "t" }).parseInbound(POSTMARK_INBOUND);
    expect(toIngestPayload(inbound, "in.pms.example")).toMatchObject({
      provider_message_id: "pm-inbound-1",
      account_token: "k3j9x2m8qa",
      reply_token: "ab12cd34ef",
      reply_token_source: "address",
      from_email: "ada@example.com",
      from_name: "Ada Lovelace",
      subject: "Your stay",
      raw_subject: "Re: Your stay [#ab12cd34ef]",
      text: "Can we check in early?",
      // In-Reply-To first, then References newest first, without duplicates.
      thread_ids: ["<m1@pms>", "<m0@pms>"],
    });
  });
});

function claimed(id: string, attempts = 1): ClaimedOutbound {
  return {
    messageId: id,
    accountId: "acc",
    attempts,
    toAddress: "ada@example.com",
    toName: "Ada",
    subject: "Your stay",
    body: "Hello",
    rfcMessageId: `<${id}@pms>`,
    inReplyTo: null,
    references: [],
    replyToken: "ab12cd34ef",
    accountToken: "k3j9x2m8qa",
    senderName: "Sunny",
  };
}

function memoryStore(items: ClaimedOutbound[]) {
  const results: { id: string; result: OutboxResult }[] = [];
  const store: OutboxStore = {
    claim: vi.fn(async () => items),
    record: vi.fn(async (id: string, result: OutboxResult) => {
      results.push({ id, result });
    }),
  };
  return { store, results };
}

describe("outbox worker (INB-10)", () => {
  const now = () => new Date("2026-11-23T12:00:00Z");

  it("records sent and delivered outcomes with the provider id", async () => {
    const { store, results } = memoryStore([claimed("m1"), claimed("m2")]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ providerMessageId: "p1", delivered: false })
      .mockResolvedValueOnce({ providerMessageId: "p2", delivered: true });
    const summary = await processOutbox({ store, provider: { ...logProvider(), name: "postmark", send }, config: CONFIG, now });
    expect(summary).toEqual({ claimed: 2, sent: 2, retrying: 0, failed: 0 });
    expect(results).toEqual([
      { id: "m1", result: { outcome: "sent", provider: "postmark", providerMessageId: "p1", error: null, retryAt: null } },
      { id: "m2", result: { outcome: "delivered", provider: "postmark", providerMessageId: "p2", error: null, retryAt: null } },
    ]);
    expect(send.mock.calls[0][0]).toMatchObject({ subject: "Re: Your stay [#ab12cd34ef]", replyTo: "k3j9x2m8qa+ab12cd34ef@in.pms.example" });
  });

  it("retries transient errors with backoff and gives up after the last attempt", async () => {
    const { store, results } = memoryStore([claimed("m1", 1), claimed("m2", OUTBOX_MAX_ATTEMPTS)]);
    const send = vi.fn().mockRejectedValue(new EmailSendError("timeout", false));
    const summary = await processOutbox({ store, provider: { ...logProvider(), send }, config: CONFIG, now, random: () => 0.5 });
    expect(summary).toEqual({ claimed: 2, sent: 0, retrying: 1, failed: 1 });
    expect(results[0].result).toMatchObject({ outcome: "retry", error: "timeout", retryAt: new Date("2026-11-23T12:00:30Z") });
    expect(results[1].result).toMatchObject({ outcome: "failed", error: "timeout", retryAt: null });
  });

  it("fails permanent errors at once", async () => {
    const { store, results } = memoryStore([claimed("m1", 1)]);
    const send = vi.fn().mockRejectedValue(new EmailSendError("Postmark 300: Invalid email", true));
    await processOutbox({ store, provider: { ...logProvider(), send }, config: CONFIG, now });
    expect(results[0].result).toMatchObject({ outcome: "failed", error: "Postmark 300: Invalid email" });
  });

  it("passes the account filter and limits to the store", async () => {
    const { store } = memoryStore([]);
    await processOutbox({ store, provider: logProvider(), config: CONFIG, limit: 5, accountId: "acc" });
    expect(store.claim).toHaveBeenCalledWith(5, 60, "acc");
  });
});
