import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Alert, Badge, Card, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { publicEnv } from "@/lib/env";
import { LISTING_STATUS_LABELS, LISTING_STATUS_TONE, type CleaningStatus, type ListingStatus } from "@/lib/properties/constants";
import { formatMoney } from "@/lib/properties/money";
import { photoUrl } from "@/lib/properties/photos";
import { getListing } from "@/lib/properties/queries";
import { createClient } from "@/lib/supabase/server";

import { AddSubUnitsForm, SubUnitRow } from "./units-client";

export const metadata: Metadata = { title: "Sub-units" };

export default function UnitsPage({ params }: PageProps<"/properties/[id]/units">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Units params={params} />
    </Suspense>
  );
}

interface SubUnit {
  id: string;
  internal_name: string;
  status: ListingStatus;
  cleaning_status: CleaningStatus;
  cleaning_status_updated_at: string | null;
}

async function Units({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuthContext({ permission: "properties.view", returnTo: `/properties/${id}/units` });
  const supabase = await createClient();
  const parent = await getListing(supabase, id);
  if (!parent) notFound();
  if (parent.type !== "multi_parent") {
    return <Alert>This listing is not a multi-unit.</Alert>;
  }

  const [{ data: subs }, { data: parents }, { data: cover }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, internal_name, status, cleaning_status, cleaning_status_updated_at")
      .eq("parent_id", id)
      .order("status")
      .order("internal_name")
      .returns<SubUnit[]>(),
    supabase.from("listings").select("id, internal_name").eq("account_id", ctx.active.accountId).eq("type", "multi_parent").neq("status", "archived").neq("id", id).order("internal_name").returns<{ id: string; internal_name: string }[]>(),
    supabase.from("listing_photos").select("storage_path").eq("listing_id", id).order("position").limit(1).returns<{ storage_path: string }[]>(),
  ]);
  const active = (subs ?? []).filter((s) => s.status !== "archived");
  const archived = (subs ?? []).filter((s) => s.status === "archived");
  // Next reservation / owner-stay arrival per sub-unit (Calendar: public.next_arrivals).
  const { data: arrivals } = active.length
    ? await supabase.rpc("next_arrivals", { p_listing_ids: active.map((s) => s.id) })
    : { data: [] };
  const nextArrival = new Map(((arrivals ?? []) as { listing_id: string; check_in: string }[]).map((a) => [a.listing_id, a.check_in]));
  const canEdit = ctx.can("properties.edit");
  const canManage = ctx.can("properties.manage");
  const ready = active.filter((s) => s.cleaning_status === "clean" || s.cleaning_status === "inspected").length;

  return (
    <>
      <nav className="mb-2 text-sm text-slate-500" aria-label="Breadcrumb">
        <Link href="/properties" className="hover:underline">
          Properties
        </Link>
        {" / "}
        <Link href={`/properties/${id}`} className="hover:underline">
          {parent.internal_name}
        </Link>
      </nav>
      <PageHeader
        title={`${parent.internal_name} — sub-units`}
        description="Content, prices and rules are edited on the parent. Each sub-unit has its own availability and cleaning status."
      />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          {cover?.[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(publicEnv().supabaseUrl, cover[0].storage_path, "thumb")} alt="" className="h-16 w-24 rounded object-cover" />
          ) : null}
          <div className="space-y-1 text-sm">
            <p className="font-medium">{parent.public_title ?? parent.internal_name}</p>
            <p className="text-slate-500">
              {[parent.address_line1, parent.city, parent.state_region].filter(Boolean).join(", ") || "No address yet"} · {formatMoney(parent.base_price_cents)} / night · up to{" "}
              {parent.max_guests ?? "?"} guests
            </p>
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={LISTING_STATUS_TONE[parent.status]}>{LISTING_STATUS_LABELS[parent.status]}</Badge>
              <span className="text-slate-500">
                {active.length} unit{active.length === 1 ? "" : "s"} · {ready} ready for arrival
              </span>
            </p>
          </div>
          <Link href={`/properties/${id}`} className="ml-auto text-sm underline">
            Edit parent
          </Link>
        </div>
      </Card>

      <Card title="Sub-units">
        {active.length === 0 ? <p className="text-sm text-slate-500">No sub-units yet.</p> : null}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {active.map((s) => (
            <SubUnitRow
              key={s.id}
              parentId={id}
              unit={{ id: s.id, name: s.internal_name, status: s.status, cleaningStatus: s.cleaning_status, cleaningUpdatedAt: s.cleaning_status_updated_at, nextArrival: nextArrival.get(s.id) ?? null }}
              timezone={parent.timezone}
              otherParents={parents ?? []}
              canEdit={canEdit}
              canManage={canManage}
            />
          ))}
        </ul>
        {canManage && parent.status !== "archived" ? (
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <AddSubUnitsForm parentId={id} />
          </div>
        ) : null}
      </Card>

      {archived.length ? (
        <Card title="Removed (archived)" className="mt-4">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {archived.map((s) => (
              <SubUnitRow
                key={s.id}
                parentId={id}
                unit={{ id: s.id, name: s.internal_name, status: s.status, cleaningStatus: s.cleaning_status, cleaningUpdatedAt: s.cleaning_status_updated_at, nextArrival: nextArrival.get(s.id) ?? null }}
                timezone={parent.timezone}
                otherParents={[]}
                canEdit={false}
                canManage={canManage && parent.status !== "archived"}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
