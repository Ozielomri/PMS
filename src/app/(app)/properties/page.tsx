import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Button, Card, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { publicEnv } from "@/lib/env";
import { LISTING_STATUSES, LISTING_STATUS_LABELS, LISTING_TYPE_LABELS, type CleaningStatus, type ListingStatus, type ListingType } from "@/lib/properties/constants";
import { photoUrl } from "@/lib/properties/photos";
import { createClient } from "@/lib/supabase/server";

import { ListingsTable, type ListingListItem } from "./listings-table";

export const metadata: Metadata = { title: "Properties" };

const PAGE_SIZE = 50;

export default function PropertiesPage({ searchParams }: PageProps<"/properties">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Properties searchParams={searchParams} />
    </Suspense>
  );
}

interface Row {
  id: string;
  internal_name: string;
  public_title: string | null;
  type: ListingType;
  status: ListingStatus;
  city: string | null;
  state_region: string | null;
  tags: string[];
  cleaning_status: CleaningStatus | null;
  base_price_cents: number | null;
  listing_photos: { storage_path: string; position: number }[];
  listing_channel_links: { channel: string; status: string }[];
}

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Escape a value for a PostgREST ilike pattern inside or(). */
function like(v: string): string {
  return `%${v.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/[,()"]/g, " ")}%`;
}

async function Properties({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "properties.view", returnTo: "/properties" });
  const params = await searchParams;
  const q = str(params.q);
  const tag = str(params.tag);
  const city = str(params.city);
  const type = str(params.type);
  const status = str(params.status);
  const page = Math.max(1, Number(str(params.page)) || 1);

  const supabase = await createClient();
  const accountId = ctx.active.accountId;
  let query = supabase
    .from("listings")
    .select(
      "id, internal_name, public_title, type, status, city, state_region, tags, cleaning_status, base_price_cents, listing_photos(storage_path, position), listing_channel_links(channel, status)",
      { count: "exact" },
    )
    .eq("account_id", accountId)
    .neq("type", "sub_unit")
    .order("internal_name")
    .order("position", { referencedTable: "listing_photos", ascending: true })
    .limit(1, { referencedTable: "listing_photos" })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (q) query = query.or(`internal_name.ilike.${like(q)},public_title.ilike.${like(q)},city.ilike.${like(q)},address_line1.ilike.${like(q)}`);
  if (tag) query = query.contains("tags", [tag]);
  if (city) query = query.ilike("city", city.replace(/[%_\\]/g, (c) => `\\${c}`));
  if (type === "single" || type === "multi_parent") query = query.eq("type", type);
  if ((LISTING_STATUSES as readonly string[]).includes(status)) query = query.eq("status", status);
  else if (status !== "all") query = query.neq("status", "archived");

  const [{ data: rows, count }, { data: facets }, { data: amenities }] = await Promise.all([
    query.returns<Row[]>(),
    supabase.from("listings").select("tags, city").eq("account_id", accountId).neq("status", "archived").limit(5000).returns<{ tags: string[]; city: string | null }[]>(),
    supabase.from("amenities").select("code, label").order("sort").returns<{ code: string; label: string }[]>(),
  ]);

  // Sub-unit counts and cleaning summary for the multi-unit parents on this page.
  const parentIds = (rows ?? []).filter((r) => r.type === "multi_parent").map((r) => r.id);
  const { data: subs } = parentIds.length
    ? await supabase
        .from("listings")
        .select("parent_id, cleaning_status")
        .in("parent_id", parentIds)
        .neq("status", "archived")
        .returns<{ parent_id: string; cleaning_status: CleaningStatus | null }[]>()
    : { data: [] as { parent_id: string; cleaning_status: CleaningStatus | null }[] };

  const { supabaseUrl } = publicEnv();
  const items: ListingListItem[] = (rows ?? []).map((r) => {
    const units = (subs ?? []).filter((s) => s.parent_id === r.id);
    return {
      id: r.id,
      name: r.internal_name,
      title: r.public_title,
      type: r.type,
      status: r.status,
      city: [r.city, r.state_region].filter(Boolean).join(", "),
      tags: r.tags,
      cleaningStatus: r.cleaning_status,
      units: r.type === "multi_parent" ? { total: units.length, dirty: units.filter((u) => u.cleaning_status === "dirty").length } : null,
      basePriceCents: r.base_price_cents,
      photo: r.listing_photos[0] ? photoUrl(supabaseUrl, r.listing_photos[0].storage_path, "thumb") : null,
      channels: r.listing_channel_links.map((c) => c.channel),
    };
  });

  const allTags = [...new Set((facets ?? []).flatMap((f) => f.tags))].sort((a, b) => a.localeCompare(b));
  const allCities = [...new Set((facets ?? []).map((f) => f.city).filter((c): c is string => Boolean(c)))].sort();
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => `/properties?${new URLSearchParams({ ...Object.fromEntries(Object.entries({ q, tag, city, type, status }).filter(([, v]) => v)), page: String(p) })}`;
  const exportHref = `/properties/export?${new URLSearchParams(Object.fromEntries(Object.entries({ q, tag, city, type, status }).filter(([, v]) => v)))}`;

  return (
    <>
      <PageHeader
        title="Properties"
        description={`${total} listing${total === 1 ? "" : "s"}. Sub-units are listed under their multi-unit.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={exportHref} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              Export CSV
            </a>
            {ctx.can("properties.manage") ? (
              <>
                <Link href="/properties/custom-fields" className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  Custom fields
                </Link>
                <Link href="/properties/new" className="inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900">
                  New listing
                </Link>
              </>
            ) : null}
          </div>
        }
      />
      <Card className="mb-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" role="search" aria-label="Filter properties">
          <div className="sm:col-span-2">
            <label htmlFor="q" className="sr-only">
              Search
            </label>
            <Input id="q" name="q" defaultValue={q} placeholder="Search name, title, address, city" type="search" />
          </div>
          <Select name="tag" defaultValue={tag} aria-label="Tag">
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select name="city" defaultValue={city} aria-label="City">
            <option value="">All cities</option>
            {allCities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Select name="type" defaultValue={type} aria-label="Type">
            <option value="">All types</option>
            <option value="single">{LISTING_TYPE_LABELS.single}</option>
            <option value="multi_parent">{LISTING_TYPE_LABELS.multi_parent}</option>
          </Select>
          <div className="flex gap-2">
            <Select name="status" defaultValue={status} aria-label="Status">
              <option value="">Not archived</option>
              {LISTING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LISTING_STATUS_LABELS[s]}
                </option>
              ))}
              <option value="all">All</option>
            </Select>
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </div>
        </form>
      </Card>
      <ListingsTable items={items} canEdit={ctx.can("properties.edit")} amenities={amenities ?? []} />
      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : <span />}
          <span className="text-slate-500">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={pageHref(page + 1)}>Next →</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}
