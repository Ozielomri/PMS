import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Alert, Badge, Card, Skeleton, cx } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import {
  ACTIVATION_PROBLEM_LABELS,
  CLEANING_STATUS_LABELS,
  CLEANING_STATUS_TONE,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_TONE,
  LISTING_TYPE_LABELS,
} from "@/lib/properties/constants";
import { getActivationProblems, getListing } from "@/lib/properties/queries";
import { EDITOR_TABS, SUB_UNIT_TABS, TAB_LABELS, isEditorTab, type EditorTab } from "@/lib/properties/schemas";
import { createClient } from "@/lib/supabase/server";

import { ActionForm } from "@/components/action-form";
import { GuardedLink, UnsavedChangesProvider } from "../_components/autosave";
import { duplicateListing, setListingStatus } from "../actions";
import { TabContent } from "./tabs";

export const metadata: Metadata = { title: "Listing" };

export default function ListingEditorPage({ params, searchParams }: PageProps<"/properties/[id]">) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Editor params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Editor({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const ctx = await requireAuthContext({ permission: "properties.view", returnTo: `/properties/${id}` });
  const sp = await searchParams;
  const supabase = await createClient();
  const listing = await getListing(supabase, id);
  if (!listing) notFound();

  // iCal settings (CAL-09/10) need calendar.manage; a complex has no calendar.
  const tabs: readonly EditorTab[] = (listing.type === "sub_unit" ? SUB_UNIT_TABS : EDITOR_TABS).filter(
    (t) => t !== "ical" || (ctx.can("calendar.manage") && listing.type !== "complex"),
  );
  const tab: EditorTab = isEditorTab(sp.tab) && tabs.includes(sp.tab) ? sp.tab : "overview";
  const wizard = sp.wizard === "1";
  const [problems, parent] = await Promise.all([
    getActivationProblems(supabase, id),
    listing.parent_id ? getListing(supabase, listing.parent_id) : Promise.resolve(null),
  ]);
  const canEdit = ctx.can("properties.edit");
  const canManage = ctx.can("properties.manage");

  return (
    <UnsavedChangesProvider>
      <nav className="mb-2 text-sm text-slate-500" aria-label="Breadcrumb">
        <GuardedLink href="/properties" className="hover:underline">
          Properties
        </GuardedLink>
        {parent ? (
          <>
            {" / "}
            <GuardedLink href={`/properties/${parent.id}`} className="hover:underline">
              {parent.internal_name}
            </GuardedLink>
          </>
        ) : null}
      </nav>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{listing.internal_name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge>{LISTING_TYPE_LABELS[listing.type]}</Badge>
            <Badge tone={LISTING_STATUS_TONE[listing.status]}>{LISTING_STATUS_LABELS[listing.status]}</Badge>
            {listing.cleaning_status ? (
              <Badge tone={CLEANING_STATUS_TONE[listing.cleaning_status]}>{CLEANING_STATUS_LABELS[listing.cleaning_status]}</Badge>
            ) : null}
            {listing.public_title ? <span className="text-slate-500">{listing.public_title}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {listing.type === "multi_parent" ? (
            <GuardedLink href={`/properties/${id}/units`} className="inline-flex rounded-xl border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700">
              Sub-units
            </GuardedLink>
          ) : null}
          {canEdit && listing.status === "draft" ? (
            <ActionForm action={setListingStatus} fields={{ listingId: id, status: "active" }} label="Activate" variant="primary" pendingLabel="Activating…" />
          ) : null}
          {canEdit && listing.status === "active" ? (
            <ActionForm action={setListingStatus} fields={{ listingId: id, status: "draft" }} label="Move to draft" confirm="Move to draft? The listing stops taking new bookings." />
          ) : null}
          {canManage && listing.status !== "archived" ? (
            <ActionForm
              action={setListingStatus}
              fields={{ listingId: id, status: "archived" }}
              label="Archive"
              variant="ghost"
              confirm="Archive this listing? It keeps its history but cannot take new bookings."
            />
          ) : null}
          {canManage && listing.status === "archived" ? (
            <ActionForm action={setListingStatus} fields={{ listingId: id, status: "draft" }} label="Restore as draft" />
          ) : null}
          {canManage && listing.type !== "complex" ? <ActionForm action={duplicateListing} fields={{ listingId: id }} label="Duplicate" variant="ghost" /> : null}
        </div>
      </header>

      {wizard || (listing.status === "draft" && problems.length > 0) ? (
        <div className="mb-4">
          <Alert tone={problems.length ? "info" : "success"}>
            {wizard ? <strong className="mr-1">Step 2 of 2: photos, then activate.</strong> : null}
            {problems.length ? (
              <>
                To activate, add: {problems.map((p) => ACTIVATION_PROBLEM_LABELS[p] ?? p).join("; ")}.
              </>
            ) : (
              <>Everything needed is in place — press Activate to make the listing bookable.</>
            )}
          </Alert>
        </div>
      ) : null}
      {listing.type === "sub_unit" ? (
        <div className="mb-4">
          <Alert>
            Content, prices and rules of a sub-unit come from its parent{" "}
            {parent ? (
              <Link href={`/properties/${parent.id}`} className="underline">
                {parent.internal_name}
              </Link>
            ) : null}
            . Here you set its name, cleaning status, custom values (e.g. its own door code) and see its log.
          </Alert>
        </div>
      ) : null}

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 text-sm dark:border-slate-800" aria-label="Listing sections">
        {tabs.map((t) => (
          <GuardedLink
            key={t}
            href={`/properties/${id}?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2",
              t === tab ? "border-slate-900 font-medium dark:border-slate-100" : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100",
            )}
          >
            {TAB_LABELS[t]}
          </GuardedLink>
        ))}
      </nav>
      <Card>
        <Suspense fallback={<Skeleton lines={6} />}>
          <TabContent tab={tab} listing={listing} canEdit={canEdit} accountId={ctx.active.accountId} searchParams={sp} />
        </Suspense>
      </Card>
    </UnsavedChangesProvider>
  );
}
