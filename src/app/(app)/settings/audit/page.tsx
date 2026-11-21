import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Card, PageHeader, Skeleton, formatDateTime } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

export default function AuditPage({ searchParams }: PageProps<"/settings/audit">) {
  return (
    <>
      <PageHeader title="Audit log" description="Every create, update and delete in this account: who, what, when and from where. Kept for 2 years." />
      <Suspense fallback={<Skeleton lines={10} />}>
        <AuditLog searchParams={searchParams} />
      </Suspense>
    </>
  );
}

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: "insert" | "update" | "delete";
  diff: Record<string, { old?: unknown; new?: unknown }>;
  ip: string | null;
}

const ACTION_TONE = { insert: "green", update: "amber", delete: "red" } as const;

async function AuditLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "audit.view", returnTo: "/settings/audit" });
  const params = await searchParams;
  const entity = typeof params.entity === "string" ? params.entity : undefined;
  const before = typeof params.before === "string" && /^\d+$/.test(params.before) ? Number(params.before) : undefined;

  const supabase = await createClient();
  let query = supabase
    .from("audit_log")
    .select("id, occurred_at, actor_type, actor_id, actor_user_id, entity_type, entity_id, action, diff, ip")
    .eq("account_id", ctx.active.accountId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);
  if (entity) query = query.eq("entity_type", entity);
  if (before) query = query.lt("id", before);
  const { data: rows } = await query.returns<AuditRow[]>();

  const userIds = [...new Set((rows ?? []).map((r) => r.actor_user_id).filter((id): id is string => Boolean(id)))];
  const { data: profiles } = userIds.length
    ? await supabase.from("profiles").select("user_id, email, full_name").in("user_id", userIds)
    : { data: [] as { user_id: string; email: string; full_name: string | null }[] };
  const nameById = new Map((profiles ?? []).map((p) => [p.user_id, p.full_name ?? p.email]));

  const entities = ["accounts", "memberships", "membership_listing_scopes", "invitations", "webhook_endpoints"];
  const last = rows?.at(-1);

  return (
    <Card>
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filter by entity">
        <Link href="/settings/audit" className={!entity ? "font-semibold" : "text-slate-500"}>
          All
        </Link>
        {entities.map((e) => (
          <Link key={e} href={`/settings/audit?entity=${e}`} className={entity === e ? "font-semibold" : "text-slate-500"}>
            {e}
          </Link>
        ))}
      </nav>
      {rows?.length ? (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {rows.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={ACTION_TONE[r.action]}>{r.action}</Badge>
                <code className="text-xs">
                  {r.entity_type}/{r.entity_id.slice(0, 8)}
                </code>
                <span className="text-slate-600 dark:text-slate-300">
                  by {r.actor_type === "user" ? (nameById.get(r.actor_user_id ?? "") ?? "a user") : `${r.actor_type}${r.actor_id ? ` (${r.actor_id})` : ""}`}
                </span>
                <span className="ml-auto text-xs text-slate-500">
                  {formatDateTime(r.occurred_at)}
                  {r.ip ? ` · ${r.ip}` : ""}
                </span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-slate-500">{Object.keys(r.diff).join(", ") || "no fields"}</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs dark:bg-slate-950">{JSON.stringify(r.diff, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">No entries.</p>
      )}
      {rows && rows.length === PAGE_SIZE && last ? (
        <Link className="mt-4 inline-block text-sm underline" href={`/settings/audit?${new URLSearchParams({ ...(entity ? { entity } : {}), before: String(last.id) })}`}>
          Older entries →
        </Link>
      ) : null}
    </Card>
  );
}
