import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, Input, PageHeader, Skeleton, cx, formatDateTime } from "@/components/ui";
import { aiStatus } from "@/lib/ai/config";
import { requireAuthContext } from "@/lib/auth/context";
import { emailConfig, emailProviderName, inboundAddress } from "@/lib/inbox/config";
import { DELIVERY_STATUSES, deliveryLabel, deliveryTone, type DeliveryStatus } from "@/lib/inbox/delivery";
import { formatDuration } from "@/lib/inbox/format";
import { accountToday } from "@/lib/reservations/list";
import { createClient } from "@/lib/supabase/server";

import { discardMessage, retryMessage, updateInboxSettings } from "../actions";

export const metadata: Metadata = { title: "Message log" };

export default function MessageLogPage({ searchParams }: PageProps<"/inbox/log">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <MessageLog searchParams={searchParams} />
    </Suspense>
  );
}

interface DeliveryRow {
  message_id: string;
  status: DeliveryStatus;
  to_address: string;
  attempts: number;
  provider: string | null;
  last_error: string | null;
  queued_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  message: { conversation_id: string; body: string; author: { full_name: string | null; email: string } | null } | null;
}

/** Screen 3: outbound messages with delivery status (INB-10), inbound log, response times (INB-13). */
async function MessageLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "inbox.manage", returnTo: "/inbox/log" });
  const sp = await searchParams;
  const status = (DELIVERY_STATUSES as readonly string[]).includes(String(sp.status)) ? (sp.status as DeliveryStatus) : "";
  const supabase = await createClient();
  const accountId = ctx.active.accountId;

  let deliveries = supabase
    .from("message_deliveries")
    .select("message_id, status, to_address, attempts, provider, last_error, queued_at, sent_at, delivered_at, failed_at, message:messages(conversation_id, body, author:profiles!messages_author_user_id_fkey(full_name, email))")
    .eq("account_id", accountId)
    .order("queued_at", { ascending: false })
    .limit(100);
  if (status) deliveries = deliveries.eq("status", status);

  const [{ data: rows }, { data: inbound }, { data: stats }, { data: settings }, { timeZone }] = await Promise.all([
    deliveries.returns<DeliveryRow[]>(),
    supabase
      .from("inbound_emails")
      .select("id, received_at, from_email, subject, status, match_method, conversation_id")
      .eq("account_id", accountId)
      .order("received_at", { ascending: false })
      .limit(50)
      .returns<{ id: string; received_at: string; from_email: string; subject: string | null; status: string; match_method: string | null; conversation_id: string | null }[]>(),
    supabase
      .from("inbox_response_stats")
      .select("author_user_id, full_name, email, replies, avg_seconds, median_seconds")
      .eq("account_id", accountId)
      .order("avg_seconds")
      .returns<{ author_user_id: string; full_name: string | null; email: string | null; replies: number; avg_seconds: number; median_seconds: number }[]>(),
    supabase.from("inbox_settings").select("inbound_token, sender_name, ai_drafts_enabled").eq("account_id", accountId).maybeSingle<{ inbound_token: string; sender_name: string | null; ai_drafts_enabled: boolean }>(),
    accountToday(supabase, accountId),
  ]);
  const provider = emailProviderName();
  const ai = aiStatus();

  return (
    <>
      <PageHeader
        title="Message log"
        description="Outbound messages and their delivery, every inbound email with how it was matched, and response times."
        actions={
          <Link href="/inbox" className="rounded-full border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
            Back to inbox
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Email channel" className="lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Inbound address</dt>
              <dd className="mt-0.5 break-all font-mono">{settings ? inboundAddress(settings.inbound_token) : "—"}</dd>
              <dd className="mt-1 text-xs text-slate-500">Guests can write here, and you can forward your existing mailbox to it.</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Sending</dt>
              <dd className="mt-0.5">
                {provider === "postmark" ? (
                  <>Postmark, from {emailConfig().fromAddress}</>
                ) : (
                  <>
                    <Badge tone="amber">Development adapter</Badge> Nothing is sent; messages are marked delivered. Set the provider keys to send email (see TODO.md).
                  </>
                )}
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Inbox settings">
          <ActionForm action={updateInboxSettings} fields={{}} label="Save" className="space-y-3">
            <Field label="Sender name" htmlFor="sender" hint={`Shown as the email sender; defaults to ${ctx.active.accountName}.`}>
              <Input id="sender" name="senderName" defaultValue={settings?.sender_name ?? ""} maxLength={100} />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="aiDrafts" defaultChecked={settings?.ai_drafts_enabled ?? true} className="mt-1" />
              <span>
                AI reply suggestions
                <span className="block text-xs text-slate-500">{ai.enabled ? `Model ${ai.model}. Drafts are never sent without a person.` : ai.reason}</span>
              </span>
            </label>
          </ActionForm>
        </Card>
      </div>

      <Card title="Outbound messages" className="mt-6">
        <nav aria-label="Delivery status" className="mb-3 flex flex-wrap gap-1 text-sm">
          {(["", ...DELIVERY_STATUSES] as const).map((s) => (
            <Link
              key={s || "all"}
              href={s ? `/inbox/log?status=${s}` : "/inbox/log"}
              aria-current={status === s ? "page" : undefined}
              className={cx("rounded-full px-3 py-1", status === s ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-slate-100 dark:bg-slate-800")}
            >
              {s ? deliveryLabel(s) : "All"}
            </Link>
          ))}
        </nav>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2">Queued</th>
                <th>To</th>
                <th>Message</th>
                <th>By</th>
                <th>Status</th>
                <th className="text-right">Attempts</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(rows ?? []).map((d) => (
                <tr key={d.message_id} className="align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(d.queued_at, timeZone)}</td>
                  <td className="pr-3 break-all">{d.to_address}</td>
                  <td className="max-w-xs pr-3">
                    <Link href={`/inbox?tab=all&c=${d.message?.conversation_id}`} className="line-clamp-2 underline-offset-2 hover:underline">
                      {d.message?.body}
                    </Link>
                  </td>
                  <td className="pr-3">{d.message?.author?.full_name ?? d.message?.author?.email ?? "—"}</td>
                  <td className="pr-3">
                    <Badge tone={deliveryTone(d.status)}>{deliveryLabel(d.status)}</Badge>
                    {d.last_error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{d.last_error}</p> : null}
                    {d.delivered_at ? <p className="mt-1 text-xs text-slate-500">{formatDateTime(d.delivered_at, timeZone)}</p> : null}
                  </td>
                  <td className="text-right tabular-nums">{d.attempts}</td>
                  <td className="pl-3">
                    {d.status === "failed" ? (
                      <div className="flex gap-1">
                        <ActionForm action={retryMessage} fields={{ messageId: d.message_id }} label="Retry" />
                        <ActionForm action={discardMessage} fields={{ messageId: d.message_id }} label="Discard" variant="ghost" confirm="Discard this message?" />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
              {(rows ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-slate-500">
                    No outbound messages{status ? ` with status ${deliveryLabel(status).toLowerCase()}` : ""}.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Inbound email" description="Stored even when no reservation matches; such conversations attach once the booking exists." className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2">Received</th>
                  <th>From</th>
                  <th>Subject</th>
                  <th>Matched by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(inbound ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(e.received_at, timeZone)}</td>
                    <td className="pr-3 break-all">{e.from_email}</td>
                    <td className="pr-3">
                      {e.conversation_id ? (
                        <Link href={`/inbox?tab=all&c=${e.conversation_id}`} className="underline-offset-2 hover:underline">
                          {e.subject ?? "(no subject)"}
                        </Link>
                      ) : (
                        (e.subject ?? "(no subject)")
                      )}
                    </td>
                    <td>{e.match_method ? <Badge tone={e.match_method === "new_conversation" ? "amber" : "green"}>{e.match_method.replace(/_/g, " ")}</Badge> : <Badge tone="red">{e.status}</Badge>}</td>
                  </tr>
                ))}
                {(inbound ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-slate-500">
                      No inbound email yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Response time" description="Time from a guest message to the first reply, last 90 days.">
          <ul className="space-y-2 text-sm">
            {(stats ?? []).map((s) => (
              <li key={s.author_user_id} className="flex justify-between gap-2">
                <span>{s.full_name ?? s.email ?? "Member"}</span>
                <span className="text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {formatDuration(s.avg_seconds)} avg · {formatDuration(s.median_seconds)} median · {s.replies}
                </span>
              </li>
            ))}
            {(stats ?? []).length === 0 ? <li className="text-slate-500">No replies yet.</li> : null}
          </ul>
        </Card>
      </div>
    </>
  );
}
