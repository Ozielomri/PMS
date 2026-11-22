/**
 * Provider-agnostic email adapter. One implementation per provider (Postmark today, the `log`
 * adapter for development); the rest of the inbox only sees these types.
 */
import type { Address } from "@/lib/inbox/email/parse";
import type { OutboundEmail } from "@/lib/inbox/email/compose";

export interface InboundAttachment {
  name: string;
  contentType: string;
  size: number;
}

/** An inbound email after the provider's payload has been normalized. */
export interface NormalizedInbound {
  providerMessageId: string;
  from: Address;
  /** Every recipient address seen (To, Cc, original recipient), raw. */
  recipients: string[];
  subject: string | null;
  /** The new part of the message (quoted history removed). */
  text: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Metadata only; attachment content is not stored in this step. */
  attachments: InboundAttachment[];
}

export interface EmailSendResult {
  providerMessageId: string | null;
  /** True when the provider confirms delivery synchronously (the log adapter). */
  delivered: boolean;
}

export interface DeliveryEvent {
  providerMessageId: string;
  status: "delivered" | "failed";
  reason: string | null;
}

/** permanent = retrying cannot help (invalid or inactive recipient, rejected content). */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface EmailProvider {
  name: "postmark" | "log";
  send(email: OutboundEmail): Promise<EmailSendResult>;
  /** Throws on payloads that are not an inbound email. */
  parseInbound(body: unknown): NormalizedInbound;
  /** Delivery / bounce webhook → event, or null when the event is not about delivery. */
  parseEvent(body: unknown): DeliveryEvent | null;
}
