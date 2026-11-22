import Link from "next/link";

import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Field, Input, formatDateTime } from "@/components/ui";
import { decryptSecret, parseKey } from "@/lib/crypto/secrets";
import { serverEnv, siteUrl } from "@/lib/env";
import { exportUrl } from "@/lib/ical/urls";
import type { ListingRow } from "@/lib/properties/queries";
import { createClient } from "@/lib/supabase/server";

import { addFeed, createExportUrl, removeFeed, revokeExportUrl, syncFeedNow } from "./ical-actions";
import { CopyField } from "./ical-client";

interface ExportRow {
  id: string;
  token_ciphertext: string;
  token_hint: string;
  created_at: string;
}

interface Conflict {
  event_id: string;
  check_in: string;
  check_out: string;
  with: { source_type: string; source_id: string | null; code: string | null; check_in: string; check_out: string }[];
}

interface FeedRow {
  id: string;
  name: string;
  url_display: string;
  status: "pending" | "ok" | "conflict" | "error";
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  events_imported: number;
  last_result: { placed?: number; moved?: number; released?: number; restored?: number; unchanged?: boolean; skipped?: Record<string, number> } | null;
  conflicts: Conflict[];
  created_at: string;
}

const STATUS: Record<FeedRow["status"], { label: string; tone: "neutral" | "green" | "amber" | "red" }> = {
  pending: { label: "Not imported yet", tone: "neutral" },
  ok: { label: "OK", tone: "green" },
  conflict: { label: "Overlaps a booking", tone: "amber" },
  error: { label: "Failed", tone: "red" },
};

const shortDate = (d: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

function resultLine(r: FeedRow["last_result"]): string | null {
  if (!r) return null;
  if (r.unchanged) return "Unchanged since the previous import";
  const parts = [`${r.placed ?? 0} added`, `${r.moved ?? 0} changed`, `${r.released ?? 0} removed`];
  if (r.restored) parts.push(`${r.restored} restored`);
  const skipped = Object.values(r.skipped ?? {}).reduce((s, n) => s + n, 0);
  if (skipped) parts.push(`${skipped} skipped (cancelled, past or recurring)`);
  return `Last import: ${parts.join(", ")}`;
}

function bookingHref(c: Conflict["with"][number]): string | null {
  if (!c.source_id) return null;
  if (c.source_type === "reservation" || c.source_type === "owner_stay") return `/reservations/${c.source_id}`;
  return null;
}

export async function IcalTab({ listing }: { listing: ListingRow }) {
  const supabase = await createClient();
  const [{ data: exportRows }, { data: feedRows }] = await Promise.all([
    supabase.from("ical_exports").select("id, token_ciphertext, token_hint, created_at").eq("listing_id", listing.id).is("revoked_at", null).limit(1),
    supabase
      .from("ical_feeds")
      .select("id, name, url_display, status, last_run_at, last_success_at, last_error, events_imported, last_result, conflicts, created_at")
      .eq("listing_id", listing.id)
      .eq("active", true)
      .order("created_at"),
  ]);
  const exp = ((exportRows ?? []) as ExportRow[])[0] ?? null;
  const feeds = (feedRows ?? []) as FeedRow[];

  let url: string | null = null;
  let keyProblem = false;
  if (exp) {
    try {
      url = exportUrl(siteUrl(), decryptSecret(exp.token_ciphertext, parseKey(serverEnv().encryptionKey), exp.id));
    } catch {
      keyProblem = true;
    }
  }
  const lastAccess = exp ? ((await supabase.rpc("ical_export_last_access", { p_export_id: exp.id })).data as string | null) : null;
  const tz = listing.timezone ?? "America/New_York";

  return (
    <div className="space-y-10">
      <section aria-labelledby="ical-export" className="space-y-3">
        <div>
          <h2 id="ical-export" className="font-display text-xl text-slate-900 dark:text-slate-100">
            Export
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Paste this private URL into Airbnb, Vrbo or a calendar app to block the nights that are taken here. It shows booked and blocked nights only, never guest
            details.
            {listing.type === "multi_parent" ? " For a multi-unit, a night is shown as taken only when no unit is free." : null}
          </p>
        </div>
        {exp && url ? (
          <>
            <CopyField id="ical-export-url" label="Export URL" value={url} />
            <p className="text-xs text-slate-500">
              Created {formatDateTime(exp.created_at, tz)} · last fetched {lastAccess ? formatDateTime(lastAccess, tz) : "never"}
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionForm
                action={createExportUrl}
                fields={{ listingId: listing.id, rotate: "1" }}
                label="Rotate URL"
                pendingLabel="Rotating…"
                confirm="Create a new URL? The current one stops working at once; update it wherever you pasted it."
              />
              <ActionForm
                action={revokeExportUrl}
                fields={{ listingId: listing.id, exportId: exp.id }}
                label="Revoke"
                variant="ghost"
                confirm="Revoke the export URL? Channels using it stop receiving this calendar."
              />
            </div>
          </>
        ) : exp && keyProblem ? (
          <Alert tone="error">The export URL cannot be shown: the server encryption key is missing or changed. Rotate the URL to get a new one.</Alert>
        ) : (
          <ActionForm action={createExportUrl} fields={{ listingId: listing.id }} label="Create export URL" variant="primary" pendingLabel="Creating…" />
        )}
        {exp && keyProblem ? <ActionForm action={createExportUrl} fields={{ listingId: listing.id, rotate: "1" }} label="Rotate URL" /> : null}
      </section>

      <section aria-labelledby="ical-import" className="space-y-4">
        <div>
          <h2 id="ical-import" className="font-display text-xl text-slate-900 dark:text-slate-100">
            Import
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Calendars from other sites are checked every 15 minutes; their events block nights here. Removed or cancelled events free the nights on the next
            import, and a failed import keeps the current blocks.
            {listing.type === "multi_parent" ? " A feed on the multi-unit blocks every unit; add a single unit's feed on that sub-unit." : null}
          </p>
        </div>

        {feeds.length === 0 ? <p className="text-sm text-slate-500">No feeds yet.</p> : null}
        <ul className="space-y-3" aria-label="Import feeds">
          {feeds.map((f) => (
            <li key={f.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.name}</span>
                    <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-slate-500">{f.url_display}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Last run {formatDateTime(f.last_run_at, tz)} · {f.events_imported} event{f.events_imported === 1 ? "" : "s"} imported
                    {f.status === "error" && f.last_success_at ? ` · last success ${formatDateTime(f.last_success_at, tz)}` : ""}
                  </p>
                  {resultLine(f.last_result) ? <p className="text-xs text-slate-500">{resultLine(f.last_result)}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionForm action={syncFeedNow} fields={{ feedId: f.id }} label="Sync now" pendingLabel="Syncing…" />
                  <ActionForm
                    action={removeFeed}
                    fields={{ feedId: f.id, listingId: listing.id }}
                    label="Remove"
                    variant="ghost"
                    confirm={`Remove ${f.name}? Its imported blocks are released.`}
                  />
                </div>
              </div>
              {f.status === "error" && f.last_error ? (
                <div className="mt-3">
                  <Alert tone="error">{f.last_error}</Alert>
                </div>
              ) : null}
              {f.conflicts.length > 0 ? (
                <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
                  <p className="font-medium">These imported nights overlap bookings made here. Nothing was changed; move or cancel one of them.</p>
                  <ul className="mt-1 list-disc pl-5">
                    {f.conflicts.map((c) => (
                      <li key={c.event_id}>
                        {shortDate(c.check_in)} – {shortDate(c.check_out)}:{" "}
                        {c.with.map((w, i) => {
                          const href = bookingHref(w);
                          const label = w.code ?? w.source_type.replace("_", " ");
                          return (
                            <span key={`${w.source_id}-${i}`}>
                              {i > 0 ? ", " : null}
                              {href ? (
                                <Link href={href} className="underline">
                                  {label}
                                </Link>
                              ) : (
                                label
                              )}
                            </span>
                          );
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <ActionForm action={addFeed} fields={{ listingId: listing.id }} label="Add feed" variant="primary" pendingLabel="Adding and importing…" className="space-y-3">
          <h3 className="text-sm font-semibold">Add a feed</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <Field label="Name" htmlFor="ical-name">
              <Input id="ical-name" name="name" placeholder="Airbnb" required maxLength={100} />
            </Field>
            <Field label="iCal URL" htmlFor="ical-url" hint="In Airbnb: Calendar → Availability → Connect calendars → Export calendar.">
              <Input id="ical-url" name="url" type="text" inputMode="url" autoComplete="off" placeholder="https://www.airbnb.com/calendar/ical/….ics" required maxLength={2000} />
            </Field>
          </div>
        </ActionForm>
      </section>
    </div>
  );
}
