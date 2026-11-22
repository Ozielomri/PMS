/** Builds the outbound email for a claimed message (pure; the provider adapter sends it). */

export interface ClaimedMessage {
  messageId: string;
  toAddress: string;
  toName: string | null;
  subject: string | null;
  body: string;
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  replyToken: string;
  accountToken: string;
  senderName: string;
}

export interface OutboundEmail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /** Provider tag / metadata: our message id, so delivery webhooks can be matched too. */
  tag: string;
}

export interface EmailConfig {
  /** Verified sender address, e.g. stays@mail.example.com (INBOX_EMAIL_FROM). */
  fromAddress: string;
  /** Domain that receives replies, e.g. in.example.com (INBOX_INBOUND_DOMAIN). */
  inboundDomain: string;
}

export function replyAddress(accountToken: string, replyToken: string, inboundDomain: string): string {
  return `${accountToken}+${replyToken}@${inboundDomain}`;
}

function displayName(name: string): string {
  return name.replace(/["\\\r\n<>]/g, "").trim();
}

function mailbox(email: string, name: string | null): string {
  const n = name ? displayName(name) : "";
  return n ? `"${n}" <${email}>` : email;
}

export function buildOutboundEmail(m: ClaimedMessage, config: EmailConfig): OutboundEmail {
  const base = m.subject?.trim() ? `Re: ${m.subject.trim()}` : `Message from ${m.senderName}`;
  const headers: Record<string, string> = { "Message-ID": m.rfcMessageId };
  if (m.inReplyTo) headers["In-Reply-To"] = m.inReplyTo;
  if (m.references.length) headers.References = m.references.join(" ");
  return {
    from: mailbox(config.fromAddress, m.senderName),
    to: mailbox(m.toAddress, m.toName),
    replyTo: replyAddress(m.accountToken, m.replyToken, config.inboundDomain),
    subject: `${base} [#${m.replyToken}]`,
    text: m.body,
    headers,
    tag: m.messageId,
  };
}
