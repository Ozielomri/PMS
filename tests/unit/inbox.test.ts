import { describe, expect, it } from "vitest";

import { channelLimit, channelWarnings } from "@/lib/inbox/channels";
import { DELIVERY_STATUSES, canDeliveryTransition, deliveryLabel, isDeliveryFinal } from "@/lib/inbox/delivery";
import { buildOutboundEmail, replyAddress } from "@/lib/inbox/email/compose";
import { extractTokens, normalizeSubject, parseAddress, parseAddressList, stripQuotedReply } from "@/lib/inbox/email/parse";
import { parseInboxFilters, inboxFiltersToQuery } from "@/lib/inbox/filters";
import { inboxErrorMessage } from "@/lib/inbox/errors";
import { pickVariant } from "@/lib/inbox/saved-replies";
import { buildMessageVariables, findVariables, previewTemplate, resolveTemplate } from "@/lib/inbox/variables";

describe("delivery state machine (INB-10)", () => {
  it("allows the normal path queued → sending → sent → delivered", () => {
    expect(canDeliveryTransition("queued", "sending")).toBe(true);
    expect(canDeliveryTransition("sending", "sent")).toBe(true);
    expect(canDeliveryTransition("sent", "delivered")).toBe(true);
    expect(canDeliveryTransition("sending", "delivered")).toBe(true);
  });

  it("retries through queued and fails with a reason", () => {
    expect(canDeliveryTransition("sending", "queued")).toBe(true);
    expect(canDeliveryTransition("sending", "failed")).toBe(true);
    expect(canDeliveryTransition("sent", "failed")).toBe(true); // bounce
    expect(canDeliveryTransition("failed", "queued")).toBe(true); // manual retry
    expect(canDeliveryTransition("failed", "discarded")).toBe(true);
    expect(canDeliveryTransition("sending", "sending")).toBe(true); // lease expired, claimed again
  });

  it("refuses everything else", () => {
    expect(canDeliveryTransition("delivered", "failed")).toBe(false);
    expect(canDeliveryTransition("delivered", "queued")).toBe(false);
    expect(canDeliveryTransition("discarded", "queued")).toBe(false);
    expect(canDeliveryTransition("queued", "sent")).toBe(false);
    expect(canDeliveryTransition("sent", "queued")).toBe(false);
    expect(canDeliveryTransition("queued", "queued")).toBe(false);
    for (const s of DELIVERY_STATUSES) expect(canDeliveryTransition(s, s)).toBe(s === "sending");
  });

  it("labels and final states", () => {
    expect(deliveryLabel("sending")).toBe("Sending");
    expect(isDeliveryFinal("delivered")).toBe(true);
    expect(isDeliveryFinal("discarded")).toBe(true);
    expect(isDeliveryFinal("failed")).toBe(false);
  });
});

describe("message variables (INB-06)", () => {
  const vars = buildMessageVariables({
    accountName: "Sunny Stays",
    guest: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: null, language: "en" },
    reservation: {
      code: "RABC2345",
      check_in: "2026-12-04",
      check_out: "2026-12-07",
      nights: 3,
      adults: 2,
      children: 1,
      status: "confirmed",
      eta: "15:30:00",
      etd: null,
    },
    listingVars: { "listing.title": "Ocean Breeze", "custom.door_code": "4821", "custom.parking": "" },
  });

  it("builds guest, reservation, account and listing variables", () => {
    expect(vars["guest.first_name"]).toBe("Ada");
    expect(vars["guest.full_name"]).toBe("Ada Lovelace");
    expect(vars["reservation.check_in"]).toBe("Fri, Dec 4, 2026");
    expect(vars["reservation.nights"]).toBe("3");
    expect(vars["reservation.guests"]).toBe("3");
    expect(vars["reservation.eta"]).toBe("3:30 PM");
    expect(vars["reservation.etd"]).toBe("");
    expect(vars["account.name"]).toBe("Sunny Stays");
    expect(vars["custom.door_code"]).toBe("4821");
  });

  it("finds each variable once, tolerating spaces", () => {
    expect(findVariables("Hi {{ guest.first_name }}, code {{custom.door_code}} {{guest.first_name}} {{nope}}")).toEqual([
      "guest.first_name",
      "custom.door_code",
    ]);
  });

  it("resolves known variables and reports unknown or empty ones as unresolved", () => {
    const r = resolveTemplate("Hi {{guest.first_name}}, door {{custom.door_code}}, park {{custom.parking}}, wifi {{custom.wifi}}", vars);
    expect(r.text).toBe("Hi Ada, door 4821, park {{custom.parking}}, wifi {{custom.wifi}}");
    expect(r.unresolved).toEqual(["custom.parking", "custom.wifi"]);
    expect(resolveTemplate("Plain text", vars)).toEqual({ text: "Plain text", unresolved: [] });
  });

  it("works without a reservation (inquiry)", () => {
    const v = buildMessageVariables({ accountName: "A", guest: null, reservation: null, listingVars: {}, contactName: "Bob Jones" });
    expect(v["guest.first_name"]).toBe("Bob");
    expect(resolveTemplate("{{reservation.code}}", v).unresolved).toEqual(["reservation.code"]);
  });

  it("previews with markers around resolved and unresolved values", () => {
    expect(previewTemplate("Hi {{guest.first_name}} {{x.y}}", vars)).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "value", text: "Ada", name: "guest.first_name" },
      { kind: "text", text: " " },
      { kind: "missing", text: "{{x.y}}", name: "x.y" },
    ]);
  });
});

describe("inbound email parsing", () => {
  it("parses addresses", () => {
    expect(parseAddress('"Ada L." <Ada@Example.com>')).toEqual({ email: "ada@example.com", name: "Ada L." });
    expect(parseAddress("bob@example.com")).toEqual({ email: "bob@example.com", name: null });
    expect(parseAddress("not an address")).toBeNull();
    expect(parseAddressList('a@x.com, "B, C" <b@y.com>')).toEqual([
      { email: "a@x.com", name: null },
      { email: "b@y.com", name: "B, C" },
    ]);
  });

  it("extracts the account and reply token from the address, else the subject", () => {
    const domain = "in.pms.example";
    expect(extractTokens(["k3j9x2m8qa+ab12cd34ef@in.pms.example"], "Re: hi", domain)).toEqual({
      accountToken: "k3j9x2m8qa",
      replyToken: "ab12cd34ef",
      replyTokenSource: "address",
    });
    expect(extractTokens(["other@x.com", "K3J9X2M8QA@In.PMS.example"], "Re: Your stay [#ab12cd34ef]", domain)).toEqual({
      accountToken: "k3j9x2m8qa",
      replyToken: "ab12cd34ef",
      replyTokenSource: "subject",
    });
    expect(extractTokens(["someone@else.com"], "Hello", domain)).toEqual({ accountToken: null, replyToken: null, replyTokenSource: null });
  });

  it("strips quoted replies and normalizes subjects", () => {
    const text = "Thanks, see you Friday!\n\nOn Mon, Nov 23, 2026 at 10:00 AM Sunny Stays <x@y.com> wrote:\n> Hi Ada\n> Door code 1234";
    expect(stripQuotedReply(text)).toBe("Thanks, see you Friday!");
    expect(stripQuotedReply("Line one\n> quoted\nLine two")).toBe("Line one\nLine two");
    expect(stripQuotedReply("Hi\n-----Original Message-----\nold")).toBe("Hi");
    expect(normalizeSubject("Re: RE: Fwd: Your stay [#ab12cd34ef]")).toBe("Your stay");
  });
});

describe("outbound email composition", () => {
  it("uses the reply-token address and keeps the subject token", () => {
    expect(replyAddress("k3j9x2m8qa", "ab12cd34ef", "in.pms.example")).toBe("k3j9x2m8qa+ab12cd34ef@in.pms.example");
    const email = buildOutboundEmail(
      {
        messageId: "m1",
        toAddress: "ada@example.com",
        toName: "Ada",
        subject: "Your stay at Ocean Breeze",
        body: "Hello",
        rfcMessageId: "<m1@pms>",
        inReplyTo: "<abc@mail.example>",
        references: ["<abc@mail.example>"],
        replyToken: "ab12cd34ef",
        accountToken: "k3j9x2m8qa",
        senderName: "Sunny Stays",
      },
      { fromAddress: "stays@mail.pms.example", inboundDomain: "in.pms.example" },
    );
    expect(email).toEqual({
      from: '"Sunny Stays" <stays@mail.pms.example>',
      to: '"Ada" <ada@example.com>',
      replyTo: "k3j9x2m8qa+ab12cd34ef@in.pms.example",
      subject: "Re: Your stay at Ocean Breeze [#ab12cd34ef]",
      text: "Hello",
      headers: { "Message-ID": "<m1@pms>", "In-Reply-To": "<abc@mail.example>", References: "<abc@mail.example>" },
      tag: "m1",
    });
  });

  it("starts a new thread without Re:", () => {
    const email = buildOutboundEmail(
      { messageId: "m2", toAddress: "a@b.co", toName: null, subject: null, body: "x", rfcMessageId: "<m2@pms>", inReplyTo: null, references: [], replyToken: "t0t0t0t0t0", accountToken: "acc0acc0ac", senderName: "S \"Q\"" },
      { fromAddress: "f@d.co", inboundDomain: "in.d.co" },
    );
    expect(email.subject).toBe("Message from S \"Q\" [#t0t0t0t0t0]");
    expect(email.from).toBe('"S Q" <f@d.co>');
    expect(email.to).toBe("a@b.co");
    expect(email.headers).toEqual({ "Message-ID": "<m2@pms>" });
  });
});

describe("saved replies (INB-05)", () => {
  it("picks the guest's language variant, else the default", () => {
    const reply = { body: "Hello", language: "en", variants: { es: "Hola", "pt-BR": "Olá" } };
    expect(pickVariant(reply, "es")).toBe("Hola");
    expect(pickVariant(reply, "pt-BR")).toBe("Olá");
    expect(pickVariant(reply, "pt")).toBe("Olá");
    expect(pickVariant(reply, "fr")).toBe("Hello");
    expect(pickVariant(reply, null)).toBe("Hello");
  });
});

describe("channels", () => {
  it("has limits and warns about contact details on OTA channels", () => {
    expect(channelLimit("email")).toBe(20000);
    expect(channelWarnings("email", "Call me at +1 555 123 4567")).toEqual([]);
    expect(channelWarnings("booking_com", "Write to me at a@b.com or see https://x.co")).toEqual([
      "Booking.com does not allow email addresses in messages.",
      "Booking.com does not allow external links in messages.",
    ]);
  });
});

describe("inbox filters (INB-03)", () => {
  it("parses tabs and filters and round-trips", () => {
    const f = parseInboxFilters({ tab: "mine", channel: "email", listing: "bad", tag: "vip", q: " door ", c: "x" });
    expect(f).toEqual({ tab: "mine", channel: "email", listing: "", tag: "vip", q: "door", conversation: "" });
    expect(parseInboxFilters(Object.fromEntries(new URLSearchParams(inboxFiltersToQuery(f))))).toEqual(f);
    expect(parseInboxFilters({}).tab).toBe("unanswered");
    expect(inboxFiltersToQuery(parseInboxFilters({}))).toBe("");
  });
});

describe("inbox errors", () => {
  it("maps database errors", () => {
    expect(inboxErrorMessage("unresolved_variables: custom.door_code")).toMatch(/variables/);
    expect(inboxErrorMessage('new row for relation "messages" violates check constraint "messages_no_unresolved_variables"')).toMatch(/variables/);
    expect(inboxErrorMessage("no_recipient: x")).toMatch(/email address/);
    expect(inboxErrorMessage("weird")).toBe("Something went wrong. Try again.");
  });
});
