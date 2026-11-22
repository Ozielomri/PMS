/**
 * Postmark adapter (https://postmarkapp.com): outbound through the HTTP API, inbound through an
 * inbound-stream webhook (JSON), delivery and bounce webhooks for INB-10 statuses.
 * Credentials: POSTMARK_SERVER_TOKEN. No SDK: one fetch call.
 */
import { z } from "zod";

import { parseAddress, stripQuotedReply } from "@/lib/inbox/email/parse";
import { EmailSendError, type EmailProvider, type NormalizedInbound } from "@/lib/inbox/email/provider";

const API = "https://api.postmarkapp.com/email";

// Postmark error codes where a retry cannot succeed (invalid/inactive recipient, bad sender, ...).
const PERMANENT_CODES = new Set([300, 400, 401, 402, 403, 405, 406, 409, 410, 411, 412, 413]);

const contact = z.object({ Email: z.string(), Name: z.string().optional().nullable() });
const inboundSchema = z.object({
  MessageID: z.string().min(1),
  FromFull: contact,
  ToFull: z.array(contact).optional().default([]),
  CcFull: z.array(contact).optional().default([]),
  OriginalRecipient: z.string().optional().nullable(),
  Subject: z.string().optional().nullable(),
  TextBody: z.string().optional().nullable(),
  StrippedTextReply: z.string().optional().nullable(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).optional().default([]),
  Attachments: z
    .array(z.object({ Name: z.string(), ContentType: z.string(), ContentLength: z.number().optional() }))
    .optional()
    .default([]),
});

function header(headers: { Name: string; Value: string }[], name: string): string | null {
  return headers.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value.trim() || null;
}

export function postmarkProvider(opts: { serverToken: string; fetch?: typeof fetch }): EmailProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    name: "postmark",

    async send(email) {
      let res: Response;
      try {
        res = await doFetch(API, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": opts.serverToken },
          body: JSON.stringify({
            From: email.from,
            To: email.to,
            ReplyTo: email.replyTo,
            Subject: email.subject,
            TextBody: email.text,
            Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
            Metadata: { pms_message_id: email.tag },
            MessageStream: "outbound",
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new EmailSendError(`Postmark unreachable: ${(err as Error).message}`, false);
      }
      const data = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string; MessageID?: string } | null;
      if (res.ok && data && data.ErrorCode === 0) return { providerMessageId: data.MessageID ?? null, delivered: false };
      const code = data?.ErrorCode;
      const message = code !== undefined ? `Postmark ${code}: ${data?.Message ?? "error"}` : `Postmark HTTP ${res.status}`;
      const permanent = res.status === 422 && code !== undefined && PERMANENT_CODES.has(code);
      throw new EmailSendError(message, permanent);
    },

    parseInbound(body): NormalizedInbound {
      const parsed = inboundSchema.safeParse(body);
      if (!parsed.success) throw new Error(`invalid inbound payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      const p = parsed.data;
      const from = parseAddress(p.FromFull.Name ? `"${p.FromFull.Name}" <${p.FromFull.Email}>` : p.FromFull.Email);
      if (!from) throw new Error("invalid inbound payload: sender address");
      const references = (header(p.Headers, "References") ?? "").split(/\s+/).filter(Boolean);
      const text = p.StrippedTextReply?.trim() || stripQuotedReply(p.TextBody ?? "");
      return {
        providerMessageId: p.MessageID,
        from,
        recipients: [...p.ToFull, ...p.CcFull].map((c) => c.Email).concat(p.OriginalRecipient ? [p.OriginalRecipient] : []),
        subject: p.Subject ?? null,
        text,
        rfcMessageId: header(p.Headers, "Message-ID"),
        inReplyTo: header(p.Headers, "In-Reply-To"),
        references,
        attachments: p.Attachments.map((a) => ({ name: a.Name, contentType: a.ContentType, size: a.ContentLength ?? 0 })),
      };
    },

    parseEvent(body) {
      const e = body as { RecordType?: string; MessageID?: string; Type?: string; Description?: string } | null;
      if (!e?.MessageID) return null;
      if (e.RecordType === "Delivery") return { providerMessageId: e.MessageID, status: "delivered", reason: null };
      if (e.RecordType === "Bounce") {
        return { providerMessageId: e.MessageID, status: "failed", reason: [e.Type, e.Description].filter(Boolean).join(": ") || "Bounced" };
      }
      return null;
    },
  };
}
