import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Card, Input, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage({ searchParams }: PageProps<"/search">) {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Search searchParams={searchParams} />
    </Suspense>
  );
}

interface Hit {
  kind: "listing" | "reservation" | "guest";
  id: string;
  title: string;
  subtitle: string | null;
}

const KIND_LABEL = { listing: "Listing", reservation: "Reservation", guest: "Guest" } as const;

/** X-08 / RES-14 global search across listings, reservations and guests (RLS decides what is visible). */
async function Search({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ returnTo: "/search" });
  const raw = (await searchParams).q;
  const q = typeof raw === "string" ? raw.trim().slice(0, 100) : "";
  let hits: Hit[] = [];
  if (q.length >= 2) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("global_search", { p_account_id: ctx.active.accountId, p_query: q });
    hits = (data ?? []) as Hit[];
  }
  // Guests open their latest reservation (there is no separate guest page yet).
  const guestIds = hits.filter((h) => h.kind === "guest").map((h) => h.id);
  const latest = new Map<string, string>();
  if (guestIds.length) {
    const supabase = await createClient();
    const { data } = await supabase.from("reservations").select("id, guest_id").in("guest_id", guestIds).order("check_in", { ascending: false }).returns<{ id: string; guest_id: string }[]>();
    for (const r of data ?? []) if (!latest.has(r.guest_id)) latest.set(r.guest_id, r.id);
  }
  const href = (h: Hit) =>
    h.kind === "listing" ? `/properties/${h.id}` : h.kind === "reservation" ? `/reservations/${h.id}` : latest.has(h.id) ? `/reservations/${latest.get(h.id)}?tab=guest` : null;

  return (
    <>
      <PageHeader title="Search" />
      <form className="mb-6 max-w-xl" role="search">
        <label htmlFor="global-q" className="sr-only">
          Search
        </label>
        <Input id="global-q" name="q" type="search" defaultValue={q} placeholder="Confirmation code, guest name, email, phone, listing" autoFocus />
      </form>
      {q.length > 0 && q.length < 2 ? <p className="text-sm text-slate-500">Type at least 2 characters.</p> : null}
      {q.length >= 2 ? (
        <Card>
          {hits.length === 0 ? <p className="text-sm text-slate-500">Nothing found for “{q}”.</p> : null}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {hits.map((h) => {
              const link = href(h);
              return (
                <li key={`${h.kind}:${h.id}`} className="flex items-center gap-3 py-2 text-sm">
                  <Badge>{KIND_LABEL[h.kind]}</Badge>
                  <div className="min-w-0">
                    {link ? (
                      <Link href={link} className="font-medium hover:underline">
                        {h.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{h.title}</span>
                    )}
                    {h.subtitle ? <p className="truncate text-slate-500">{h.subtitle}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
