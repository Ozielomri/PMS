import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, Badge, Card, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import type { DomainEvent } from "@/lib/events/types";
import { createClient } from "@/lib/supabase/server";

import { LiveEvents } from "./live-events";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}

const MODULES: { key: string; label: string }[] = [
  { key: "account", label: "Account" },
  { key: "properties", label: "Properties" },
  { key: "calendar", label: "Calendar" },
  { key: "reservations", label: "Reservations" },
  { key: "inbox", label: "Inbox" },
  { key: "automations", label: "Automations" },
  { key: "tasks", label: "Tasks" },
];

async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ returnTo: "/dashboard" });
  const denied = (await searchParams).denied === "1";
  const granted = [...ROLE_PERMISSIONS[ctx.active.role]];

  let recent: DomainEvent[] = [];
  if (ctx.can("events.view")) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("domain_events")
      .select("id, type, account_id, occurred_at, seq, txid, entity_type, entity_id, actor_type, actor_id, payload")
      .eq("account_id", ctx.active.accountId)
      .order("seq", { ascending: false })
      .limit(20);
    recent = (data ?? []).map(rowToEvent);
  }

  return (
    <>
      <PageHeader title={ctx.active.accountName} description={`Signed in as ${ctx.user.email ?? "unknown"} · ${ROLE_LABELS[ctx.active.role]}`} />
      {denied ? (
        <div className="mb-6">
          <Alert tone="error">You do not have permission to open that page.</Alert>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Your access" description="What your role can do in this account. Enforced by the database, not just this screen.">
          <dl className="space-y-3 text-sm">
            {MODULES.map((m) => {
              const perms = granted.filter((p) => p.startsWith(`${m.key}.`) || (m.key === "account" && /^(audit|events|webhooks)\./.test(p)));
              return (
                <div key={m.key}>
                  <dt className="font-medium">{m.label}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {perms.length === 0 ? <Badge>No access</Badge> : perms.map((p) => <Badge key={p} tone="green">{label(p)}</Badge>)}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-4 text-xs text-slate-500">Two-factor: {ctx.aal === "aal2" ? "verified this session" : "not used this session"}</p>
        </Card>

        {ctx.can("events.view") ? (
          <Card title="Live activity" description="Domain events for this account, streamed as they happen.">
            <LiveEvents accountId={ctx.active.accountId} initial={recent} />
          </Card>
        ) : null}
      </div>
    </>
  );
}

function label(p: Permission) {
  return PERMISSIONS[p].replace(/^(View|Read) /, "").replace(/ in scope$/, "");
}

interface EventRow {
  id: string;
  type: string;
  account_id: string;
  occurred_at: string;
  seq: number;
  txid: number | string;
  entity_type: string;
  entity_id: string;
  actor_type: DomainEvent["actor"]["type"];
  actor_id: string | null;
  payload: Record<string, unknown>;
}

function rowToEvent(r: EventRow): DomainEvent {
  return {
    id: r.id,
    type: r.type,
    account_id: r.account_id,
    occurred_at: r.occurred_at,
    sequence: r.seq,
    transaction_id: String(r.txid),
    entity: { type: r.entity_type, id: r.entity_id },
    actor: { type: r.actor_type, id: r.actor_id },
    data: r.payload,
  };
}
