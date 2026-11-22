/**
 * Development adapter, used whenever no provider credentials are set. Sends nothing: it logs
 * that a message would be sent (never its body, which may hold a door code) and reports it as
 * delivered. Inbound accepts a simple generic JSON format, so the inbound route can be tried
 * with curl and the "Simulate guest reply" button works without a provider:
 *
 *   { "message_id": "…", "from": "Ada <ada@example.com>", "to": ["<token>@<domain>"],
 *     "subject": "…", "text": "…", "in_reply_to": "<…>", "references": ["<…>"] }
 */
import { z } from "zod";

import { parseAddress, stripQuotedReply } from "@/lib/inbox/email/parse";
import type { EmailProvider } from "@/lib/inbox/email/provider";

const genericSchema = z.object({
  message_id: z.string().min(1).max(500),
  from: z.string().min(3).max(500),
  to: z.array(z.string().max(500)).max(50),
  subject: z.string().max(1000).optional().nullable(),
  text: z.string().max(100_000).default(""),
  rfc_message_id: z.string().max(1000).optional().nullable(),
  in_reply_to: z.string().max(1000).optional().nullable(),
  references: z.array(z.string().max(1000)).max(100).optional().default([]),
});

export function logProvider(): EmailProvider {
  return {
    name: "log",
    async send(email) {
      console.info(`[inbox:log-email] would send message ${email.tag} to ${email.to} (subject ${email.subject.length} chars)`);
      return { providerMessageId: `log-${email.tag}`, delivered: true };
    },
    parseInbound(body) {
      const parsed = genericSchema.safeParse(body);
      if (!parsed.success) throw new Error(`invalid inbound payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      const p = parsed.data;
      const from = parseAddress(p.from);
      if (!from) throw new Error("invalid inbound payload: sender address");
      return {
        providerMessageId: p.message_id,
        from,
        recipients: p.to,
        subject: p.subject ?? null,
        text: stripQuotedReply(p.text),
        rfcMessageId: p.rfc_message_id ?? null,
        inReplyTo: p.in_reply_to ?? null,
        references: p.references,
        attachments: [],
      };
    },
    parseEvent(body) {
      const e = body as { provider_message_id?: string; status?: string; reason?: string } | null;
      if (!e?.provider_message_id || (e.status !== "delivered" && e.status !== "failed")) return null;
      return { providerMessageId: e.provider_message_id, status: e.status, reason: e.reason ?? null };
    },
  };
}
