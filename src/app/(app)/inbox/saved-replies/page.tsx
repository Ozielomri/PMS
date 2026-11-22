import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, PageHeader, Skeleton, cx } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { LANGUAGES } from "@/lib/inbox/saved-replies";
import { VARIABLE_CATALOG } from "@/lib/inbox/variables";
import { createClient } from "@/lib/supabase/server";

import { formatDate } from "../../reservations/_components/bits";
import { archiveSavedReply } from "../actions";
import { SavedReplyEditor, type EditorReply } from "./editor";

export const metadata: Metadata = { title: "Saved replies" };

export default function SavedRepliesPage({ searchParams }: PageProps<"/inbox/saved-replies">) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <SavedReplies searchParams={searchParams} />
    </Suspense>
  );
}

async function SavedReplies({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "inbox.manage", returnTo: "/inbox/saved-replies" });
  const sp = await searchParams;
  const editId = typeof sp.edit === "string" ? sp.edit : "";
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const supabase = await createClient();
  const accountId = ctx.active.accountId;

  const [{ data: replies }, { data: fields }, { data: samples }] = await Promise.all([
    supabase.from("saved_replies").select("id, title, shortcut, body, language, variants").eq("account_id", accountId).is("archived_at", null).order("title").returns<EditorReply[]>(),
    supabase.from("custom_fields").select("key").eq("account_id", accountId).is("archived_at", null).order("position").returns<{ key: string }[]>(),
    supabase
      .from("reservations")
      .select("id, code, check_in, guest:guests(first_name, last_name), listing:listings!reservations_listing_id_account_id_fkey(internal_name)")
      .eq("account_id", accountId)
      .eq("kind", "guest")
      .in("status", ["confirmed", "reserved", "inquiry"])
      .order("check_in", { ascending: false })
      .limit(20)
      .returns<{ id: string; code: string; check_in: string; guest: { first_name: string; last_name: string | null } | null; listing: { internal_name: string } | null }[]>(),
  ]);
  const all = replies ?? [];
  const shown = q ? all.filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || (r.shortcut ?? "").includes(q)) : all;
  const editing = editId === "new" ? null : (all.find((r) => r.id === editId) ?? null);
  const showEditor = editId === "new" || editing !== null;
  const langName = (code: string) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code;

  return (
    <>
      <PageHeader
        title="Saved replies"
        description="Reusable answers with variables and language variants. Insert them in the composer with / or the picker."
        actions={
          <div className="flex gap-2">
            <Link href="/inbox" className="rounded-full border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              Back to inbox
            </Link>
            <Link href="/inbox/saved-replies?edit=new" className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              New saved reply
            </Link>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-3">
          <form action="/inbox/saved-replies" role="search">
            <input
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search saved replies…"
              aria-label="Search saved replies"
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </form>
          {shown.length === 0 ? <p className="text-sm text-slate-500">{all.length ? "No saved reply matches." : "No saved replies yet."}</p> : null}
          <ul className="space-y-2">
            {shown.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/inbox/saved-replies?edit=${r.id}`}
                  className={cx(
                    "block rounded-2xl border p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60",
                    r.id === editId ? "border-brand-600 bg-brand-50 dark:bg-brand-800/30" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
                  )}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.title}</span>
                    {r.shortcut ? <span className="text-xs text-slate-500">/{r.shortcut}</span> : null}
                    <Badge>{langName(r.language)}</Badge>
                    {Object.keys(r.variants).map((l) => (
                      <Badge key={l}>{langName(l)}</Badge>
                    ))}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-sm text-slate-500">{r.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {showEditor ? (
            <Card title={editing ? `Edit “${editing.title}”` : "New saved reply"}>
              <SavedReplyEditor
                key={editing?.id ?? "new"}
                reply={editing}
                variableNames={[...VARIABLE_CATALOG.map((v) => v.name), ...(fields ?? []).map((f) => `custom.${f.key}`)]}
                samples={(samples ?? []).map((s) => ({
                  id: s.id,
                  label: `${s.code} · ${[s.guest?.first_name, s.guest?.last_name].filter(Boolean).join(" ")} · ${s.listing?.internal_name ?? ""} · ${formatDate(s.check_in)}`,
                }))}
              />
              {editing ? (
                <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <ActionForm action={archiveSavedReply} fields={{ id: editing.id }} label="Archive" variant="ghost" confirm="Archive this saved reply? Sent messages keep their text." />
                </div>
              ) : null}
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-slate-500">Pick a saved reply to edit, or create a new one.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
