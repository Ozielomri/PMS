/**
 * Email channel configuration (read lazily, so builds work without secrets).
 *
 *   EMAIL_PROVIDER         postmark | log   (default: postmark when POSTMARK_SERVER_TOKEN is set, else log)
 *   POSTMARK_SERVER_TOKEN  Postmark server API token (sensitive)
 *   INBOX_EMAIL_FROM       verified sender address, e.g. stays@mail.example.com
 *   INBOX_INBOUND_DOMAIN   domain whose mail reaches the inbound webhook, e.g. in.example.com
 *   INBOX_WEBHOOK_SECRET   shared secret of the inbound / delivery webhooks (sensitive)
 */
import type { EmailConfig } from "@/lib/inbox/email/compose";
import { logProvider } from "@/lib/inbox/email/log";
import { postmarkProvider } from "@/lib/inbox/email/postmark";
import type { EmailProvider } from "@/lib/inbox/email/provider";

export function emailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
  return {
    fromAddress: env.INBOX_EMAIL_FROM || "inbox@localhost.test",
    inboundDomain: (env.INBOX_INBOUND_DOMAIN || "inbound.localhost.test").toLowerCase(),
  };
}

export function emailProviderName(env: Record<string, string | undefined> = process.env): "postmark" | "log" {
  if (env.EMAIL_PROVIDER === "log") return "log";
  if (env.EMAIL_PROVIDER === "postmark" || env.POSTMARK_SERVER_TOKEN) return "postmark";
  return "log";
}

export function emailProvider(env: Record<string, string | undefined> = process.env): EmailProvider {
  if (emailProviderName(env) === "postmark") {
    if (!env.POSTMARK_SERVER_TOKEN) throw new Error("Missing environment variable POSTMARK_SERVER_TOKEN. See .env.example.");
    return postmarkProvider({ serverToken: env.POSTMARK_SERVER_TOKEN });
  }
  return logProvider();
}

/** The address guests and forwarding rules write to for an account. */
export function inboundAddress(token: string, env: Record<string, string | undefined> = process.env): string {
  return `${token}@${emailConfig(env).inboundDomain}`;
}
