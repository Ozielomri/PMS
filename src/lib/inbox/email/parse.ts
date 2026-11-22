/**
 * Provider-independent helpers for inbound email: addresses, our routing tokens and the reply
 * part of a message body.
 *
 * Routing: every account has an inbound address `<account token>@<INBOX_INBOUND_DOMAIN>` (guests
 * or forwarding rules can write to it). Our outbound emails set Reply-To to
 * `<account token>+<reply token>@<domain>` and add `[#<reply token>]` to the subject, so a reply
 * lands in its conversation even when a mail client drops one of the two.
 */

export interface Address {
  email: string;
  name: string | null;
}

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const TOKEN = /^[a-z0-9]{10,32}$/;
const SUBJECT_TOKEN = /\[#([a-z0-9]{10,32})\]/i;

export function parseAddress(value: string): Address | null {
  const raw = value.trim();
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(raw);
  const email = (angle ? angle[2] : raw).trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  const name = angle ? angle[1].trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return { email, name: name || null };
}

/** Splits a header like `a@x.com, "B, C" <b@y.com>` (commas inside quotes are kept). */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map(parseAddress).filter((a): a is Address => a !== null);
}

export interface RoutingTokens {
  accountToken: string | null;
  replyToken: string | null;
  replyTokenSource: "address" | "subject" | null;
}

export function extractTokens(recipients: string[], subject: string | null | undefined, inboundDomain: string): RoutingTokens {
  const domain = inboundDomain.trim().toLowerCase();
  let accountToken: string | null = null;
  let replyToken: string | null = null;
  for (const r of recipients) {
    const addr = parseAddress(r);
    if (!addr || !domain) continue;
    const [local, host] = addr.email.split("@");
    if (host !== domain) continue;
    const [acc, reply] = local.split("+", 2);
    if (TOKEN.test(acc)) {
      accountToken ??= acc;
      if (reply && TOKEN.test(reply) && !replyToken) replyToken = reply;
    }
  }
  if (replyToken) return { accountToken, replyToken, replyTokenSource: "address" };
  const fromSubject = SUBJECT_TOKEN.exec(subject ?? "")?.[1]?.toLowerCase() ?? null;
  return { accountToken, replyToken: fromSubject, replyTokenSource: fromSubject ? "subject" : null };
}

/** "Re: Fwd: Your stay [#token]" → "Your stay". */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").replace(SUBJECT_TOKEN, "").trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|sv)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

const QUOTE_HEADERS = [
  /^On .{4,300}wrote:\s*$/i, // Gmail / Apple Mail (may wrap: joined below)
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^From: .+$/i, // Outlook block
  /^_{5,}$/,
  /^Sent from my /i,
];

/**
 * The new part of a reply: everything above the first quote header, without `>` lines.
 * Providers that already strip replies (Postmark's StrippedTextReply) are preferred over this.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const joined = `${line} ${lines[i + 1] ?? ""}`.trim();
    if (QUOTE_HEADERS.some((re) => re.test(line.trim())) || /^On .{4,300}wrote:\s*$/i.test(joined)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const result = out.join("\n").trim();
  return result || text.trim();
}
