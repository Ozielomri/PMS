import type { Metadata } from "next";
import { Suspense } from "react";

import { Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";

import { redeliver, setEndpointActive } from "./actions";
import { CreateEndpointForm, RotateSecretButton } from "./webhook-forms";

export const metadata: Metadata = { title: "Webhooks" };

export default function WebhooksPage() {
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Send domain events to your own systems. Each request is signed with HMAC-SHA256 and retried with backoff for 24 hours."
      />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Webhooks />
      </Suspense>
    </>
  );
}

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  event_types: string[];
  secret_last4: string;
  active: boolean;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attempt_count: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  redelivery_of: string | null;
  created_at: string;
}

const STATUS_TONE = { pending: "amber", delivering: "amber", succeeded: "green", failed: "red" } as const;

async function Webhooks() {
  const ctx = await requireAuthContext({ permission: "webhooks.manage", returnTo: "/settings/webhooks" });
  const supabase = await createClient();
  const accountId = ctx.active.accountId;

  const [{ data: endpoints }, { data: deliveries }] = await Promise.all([
    supabase
      .from("webhook_endpoints")
      .select("id, url, description, event_types, secret_last4, active, created_at")
      .eq("account_id", accountId)
      .order("created_at")
      .returns<EndpointRow[]>(),
    supabase
      .from("webhook_deliveries")
      .select("id, endpoint_id, event_id, event_type, status, attempt_count, next_attempt_at, last_status_code, last_error, redelivery_of, created_at")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<DeliveryRow[]>(),
  ]);
  const urlById = new Map((endpoints ?? []).map((e) => [e.id, e.url]));

  return (
    <div className="space-y-6">
      <Card title="Add endpoint">
        <CreateEndpointForm />
      </Card>

      <Card title="Endpoints">
        {endpoints?.length ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {endpoints.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 space-y-1">
                  <p className="break-all font-medium">{e.url}</p>
                  {e.description ? <p className="text-slate-500">{e.description}</p> : null}
                  <p className="flex flex-wrap gap-1">
                    {e.event_types.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </p>
                  <p className="text-xs text-slate-500">Secret ends in …{e.secret_last4}</p>
                </div>
                <div className="flex items-center gap-2">
                  {e.active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>}
                  <form action={setEndpointActive}>
                    <input type="hidden" name="endpointId" value={e.id} />
                    <input type="hidden" name="active" value={String(!e.active)} />
                    <button type="submit" className="text-sm underline-offset-2 hover:underline">
                      {e.active ? "Disable" : "Enable"}
                    </button>
                  </form>
                  <RotateSecretButton endpointId={e.id} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No endpoints yet.</p>
        )}
      </Card>

      <Card title="Recent deliveries" description="The last 50 deliveries across all endpoints.">
        {deliveries?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Endpoint</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2 pr-3">Created</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {deliveries.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="py-2 pr-3">
                      <code className="text-xs">{d.event_type}</code>
                      {d.redelivery_of ? <span className="ml-1 text-xs text-slate-500">(redelivery)</span> : null}
                    </td>
                    <td className="max-w-[220px] truncate py-2 pr-3 text-slate-500" title={urlById.get(d.endpoint_id)}>
                      {urlById.get(d.endpoint_id)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                      {d.last_status_code || d.last_error ? (
                        <p className="mt-1 text-xs text-slate-500">{d.last_error ?? `HTTP ${d.last_status_code}`}</p>
                      ) : null}
                      {d.status === "pending" && d.attempt_count > 0 ? (
                        <p className="text-xs text-slate-500">next try {formatDateTime(d.next_attempt_at)}</p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">{d.attempt_count}</td>
                    <td className="py-2 pr-3 text-slate-500">{formatDateTime(d.created_at)}</td>
                    <td className="py-2 text-right">
                      {d.status === "failed" || d.status === "succeeded" ? (
                        <form action={redeliver}>
                          <input type="hidden" name="deliveryId" value={d.id} />
                          <button type="submit" className="text-sm underline-offset-2 hover:underline">
                            Redeliver
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No deliveries yet.</p>
        )}
      </Card>
    </div>
  );
}
