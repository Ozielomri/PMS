"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert, Badge, Button, Card, Input, Select } from "@/components/ui";
import {
  CHANNEL_LABELS,
  CLEANING_STATUS_LABELS,
  CLEANING_STATUS_TONE,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_TONE,
  LISTING_TYPE_LABELS,
  type CleaningStatus,
  type ListingStatus,
  type ListingType,
} from "@/lib/properties/constants";
import { formatMoney } from "@/lib/properties/money";
import { BULK_ACTIONS, type BulkAction } from "@/lib/properties/schemas";

import { bulkEdit } from "./actions";

export interface ListingListItem {
  id: string;
  name: string;
  title: string | null;
  type: ListingType;
  status: ListingStatus;
  city: string;
  tags: string[];
  cleaningStatus: CleaningStatus | null;
  units: { total: number; dirty: number } | null;
  basePriceCents: number | null;
  photo: string | null;
  channels: string[];
}

export function ListingsTable({ items, canEdit, amenities }: { items: ListingListItem[]; canEdit: boolean; amenities: { code: string; label: string }[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-500">No listings match. Clear the filters or create a listing.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {canEdit && selected.size > 0 ? <BulkPanel ids={[...selected]} amenities={amenities} /> : null}
      <Card className="p-0 sm:p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <tr>
                {canEdit ? (
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2">Listing</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">City</th>
                <th className="px-3 py-2">Tags</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Cleaning</th>
                <th className="px-3 py-2">Channels</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((i) => (
                <tr key={i.id} className={selected.has(i.id) ? "bg-slate-50 dark:bg-slate-800/50" : undefined}>
                  {canEdit ? (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Select ${i.name}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    <Link href={`/properties/${i.id}`} className="flex items-center gap-3">
                      {i.photo ? (
                        // Variants come from Supabase image transformations (see lib/properties/photos.ts).
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={i.photo} alt="" width={64} height={48} className="h-12 w-16 rounded object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-12 w-16 items-center justify-center rounded bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">No photo</span>
                      )}
                      <span>
                        <span className="block font-medium text-slate-900 dark:text-slate-100">{i.name}</span>
                        <span className="block text-xs text-slate-500">
                          {i.title ?? ""} {i.basePriceCents ? `· ${formatMoney(i.basePriceCents)}/night` : ""}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {LISTING_TYPE_LABELS[i.type]}
                    {i.units ? (
                      <Link href={`/properties/${i.id}/units`} className="block text-xs text-slate-500 underline-offset-2 hover:underline">
                        {i.units.total} unit{i.units.total === 1 ? "" : "s"}
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{i.city || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[220px] flex-wrap gap-1">
                      {i.tags.map((t) => (
                        <Link key={t} href={`/properties?tag=${encodeURIComponent(t)}`}>
                          <Badge>{t}</Badge>
                        </Link>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={LISTING_STATUS_TONE[i.status]}>{LISTING_STATUS_LABELS[i.status]}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {i.cleaningStatus ? (
                      <Badge tone={CLEANING_STATUS_TONE[i.cleaningStatus]}>{CLEANING_STATUS_LABELS[i.cleaningStatus]}</Badge>
                    ) : i.units ? (
                      <span className="text-xs text-slate-500">{i.units.dirty ? `${i.units.dirty} dirty` : "All ready"}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{i.channels.length ? i.channels.map((c) => CHANNEL_LABELS[c] ?? c).join(", ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BulkPanel({ ids, amenities }: { ids: string[]; amenities: { code: string; label: string }[] }) {
  const [action, setAction] = useState<BulkAction>("base_price_cents");
  const [state, formAction, pending] = useActionState(bulkEdit, null);
  const kind = BULK_ACTIONS[action].kind;

  return (
    <Card title={`Bulk edit ${ids.length} selected`} description="Applies to every selected listing at once, or to none if one of them can't take the change. Sub-units inherit prices and rules from their parent.">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        {ids.map((id) => (
          <input key={id} type="hidden" name="ids" value={id} />
        ))}
        <div className="w-56">
          <label htmlFor="bulk-action" className="block text-sm font-medium">
            Change
          </label>
          <Select id="bulk-action" name="action" value={action} onChange={(e) => setAction(e.target.value as BulkAction)}>
            {Object.entries(BULK_ACTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <label htmlFor="bulk-value" className="block text-sm font-medium">
            {kind === "money" ? "Amount (USD)" : kind === "int" ? "Nights" : kind === "time" ? "Time" : kind === "tags" ? "Tags (comma separated)" : "Amenity"}
          </label>
          {kind === "amenity" ? (
            <Select id="bulk-value" name="value" key="amenity">
              {amenities.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="bulk-value"
              key={kind}
              name="value"
              type={kind === "time" ? "time" : "text"}
              inputMode={kind === "money" || kind === "int" ? "decimal" : undefined}
              required
            />
          )}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Applying…" : "Apply"}
        </Button>
      </form>
      {state?.error ? (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state?.ok ? (
        <div className="mt-3">
          <Alert tone="success">{state.message}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
