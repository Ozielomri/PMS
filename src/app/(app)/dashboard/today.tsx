import Link from "next/link";

import { cx } from "@/components/ui";
import type { AuthContext } from "@/lib/auth/context";
import { publicEnv } from "@/lib/env";
import { formatMoney } from "@/lib/properties/money";
import { photoUrl } from "@/lib/properties/photos";
import { parseFilters } from "@/lib/reservations/filters";
import { accountToday, guestName, listReservations, type ReservationRow } from "@/lib/reservations/list";
import { SOURCE_LABELS, type ReservationSource } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { formatDate } from "../reservations/_components/bits";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const word = (n: number) => WORDS[n] ?? String(n);
const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/** Today (design direction 3): headline, arrival cards with photos, what needs attention, money to collect. */
export async function Today({ ctx }: { ctx: AuthContext & { active: { accountId: string; accountName: string } } }) {
  const supabase = await createClient();
  const accountId = ctx.active.accountId;
  const withMoney = ctx.can("reservations.view_money");
  await supabase.rpc("expire_overdue_reservations");
  const { today } = await accountToday(supabase, accountId);
  const opts = { today, limit: 8, offset: 0, withMoney };
  const load = (tab: string, extra: Record<string, string> = {}) => listReservations(supabase, accountId, parseFilters({ tab, ...extra }), opts);
  const [arriving, inHouse, pending, inquiries, { count: properties }] = await Promise.all([
    load("arriving"),
    load("in_house"),
    load("pending"),
    load("all", { status: "inquiry" }),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("account_id", accountId).neq("type", "sub_unit").eq("status", "active"),
  ]);

  // Cover photos: a unit of a multi-unit shows its multi-unit's photo.
  const listingIds = [...new Set(arriving.rows.map((r) => r.listing_id))];
  const { data: listings } = listingIds.length
    ? await supabase.from("listings").select("id, parent_id, city, state_region").in("id", listingIds).returns<{ id: string; parent_id: string | null; city: string | null; state_region: string | null }[]>()
    : { data: [] as { id: string; parent_id: string | null; city: string | null; state_region: string | null }[] };
  const coverOf = new Map((listings ?? []).map((l) => [l.id, l.parent_id ?? l.id]));
  const coverIds = [...new Set([...coverOf.values()])];
  const { data: photos } = coverIds.length
    ? await supabase.from("listing_photos").select("listing_id, storage_path, position").in("listing_id", coverIds).order("position").returns<{ listing_id: string; storage_path: string }[]>()
    : { data: [] as { listing_id: string; storage_path: string }[] };
  const photoOf = new Map<string, string>();
  for (const p of photos ?? []) if (!photoOf.has(p.listing_id)) photoOf.set(p.listing_id, photoUrl(publicEnv().supabaseUrl, p.storage_path, "medium"));
  const placeOf = new Map((listings ?? []).map((l) => [l.id, l.city]));

  // Still to collect: balances of confirmed stays that have not ended.
  let toCollect: number | null = null;
  if (withMoney) {
    const [{ data: open }, { data: due }] = await Promise.all([
      supabase.from("reservations").select("id").eq("account_id", accountId).eq("status", "confirmed").gte("check_out", today).limit(5000).returns<{ id: string }[]>(),
      supabase.from("reservation_balances").select("reservation_id, balance_due_cents").eq("account_id", accountId).gt("balance_due_cents", 0).limit(5000).returns<{ reservation_id: string; balance_due_cents: number }[]>(),
    ]);
    const ids = new Set((open ?? []).map((r) => r.id));
    toCollect = (due ?? []).filter((b) => ids.has(b.reservation_id)).reduce((s, b) => s + Number(b.balance_due_cents), 0);
  }

  const attention: { key: string; title: string; sub: string; href: string; action: string }[] = [
    ...pending.rows.map((r) => ({
      key: r.id,
      title: `${guestName(r.guest, r.kind)} requests ${r.listing?.internal_name ?? "a stay"}`,
      sub: `${formatDate(r.check_in)} → ${formatDate(r.check_out)}${r.approval_deadline ? ` · decide by ${new Date(r.approval_deadline).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: r.listing?.timezone ?? "America/New_York" })}` : ""}`,
      href: `/reservations/${r.id}`,
      action: "Review",
    })),
    ...inquiries.rows.map((r) => ({
      key: r.id,
      title: `Inquiry from ${guestName(r.guest, r.kind)}`,
      sub: `${r.listing?.internal_name ?? ""} · ${formatDate(r.check_in)} → ${formatDate(r.check_out)}`,
      href: `/reservations/quotes/new?listing=${r.listing_id}&check_in=${r.check_in}&check_out=${r.check_out}`,
      action: "Send quote",
    })),
    ...arriving.rows
      .filter((r) => (arriving.balances.get(r.id)?.balance_due_cents ?? 0) > 0)
      .map((r) => ({
        key: `due-${r.id}`,
        title: `${guestName(r.guest, r.kind)} arrives today with a balance`,
        sub: `${formatMoney(arriving.balances.get(r.id)?.balance_due_cents, r.currency)} due · ${r.listing?.internal_name ?? ""}`,
        href: `/reservations/${r.id}?tab=financials`,
        action: "Record payment",
      })),
  ].slice(0, 5);

  const headline =
    arriving.total === 0 && inHouse.total === 0
      ? "A quiet day: no arrivals and nobody in house."
      : `${word(arriving.total)} guest${arriving.total === 1 ? "" : "s"} arrive${arriving.total === 1 ? "s" : ""} today, ${word(inHouse.total).toLowerCase()} ${inHouse.total === 1 ? "is" : "are"} settling in.`;

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="mb-1.5 text-xs uppercase tracking-[0.08em] text-slate-500">{DAY_FMT.format(new Date(`${today}T00:00:00Z`))}</p>
          <h1 className="font-display text-4xl leading-tight sm:text-5xl">{headline}</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <Stat value={inHouse.total} label="In house" href="/reservations?tab=in_house" />
          <Stat value={pending.total} label="Awaiting approval" href="/reservations?tab=pending" />
          <Stat value={properties ?? 0} label="Properties" href="/properties" />
        </div>
      </section>

      <section aria-label="Arriving today" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {arriving.rows.slice(0, 4).map((r) => (
          <ArrivalCard key={r.id} r={r} photo={photoOf.get(coverOf.get(r.listing_id) ?? r.listing_id) ?? null} place={placeOf.get(r.listing_id) ?? null} due={arriving.balances.get(r.id)?.balance_due_cents ?? null} />
        ))}
        {arriving.total === 0 ? (
          <div className="rounded-[22px] border border-dashed border-slate-300 p-6 text-sm text-slate-500 sm:col-span-2 lg:col-span-4">No arrivals today.</div>
        ) : null}
        {arriving.total > 4 ? (
          <Link href="/reservations?tab=arriving" className="text-sm font-semibold text-brand-700 sm:col-span-2 lg:col-span-4">
            All {arriving.total} arrivals →
          </Link>
        ) : null}
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <div className={cx("rounded-[22px] border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900", withMoney ? "lg:col-span-2" : "lg:col-span-3")}>
          <h2 className="mb-3 font-display text-2xl">Needs your attention</h2>
          {attention.length === 0 ? <p className="text-sm text-slate-500">Nothing waiting on you.</p> : null}
          <ul className="flex flex-col">
            {attention.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-3 border-t border-slate-100 py-3 dark:border-slate-800">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{t.title}</span>
                  <span className="truncate text-sm text-slate-500">{t.sub}</span>
                </div>
                <Link href={t.href} className="inline-flex min-h-10 shrink-0 items-center rounded-full border border-slate-300 px-4 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                  {t.action}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {withMoney ? (
          <div className="flex flex-col gap-2.5 rounded-[22px] bg-[#3f2a1e] p-6 text-[#f6f1ea]">
            <h2 className="font-display text-2xl">Still to collect</h2>
            <span className="font-display text-5xl tabular-nums">{formatMoney(toCollect ?? 0)}</span>
            <span className="text-sm text-[#d6c7b3]">Across confirmed stays that have not ended. Payments are recorded by hand in this phase.</span>
            <Link href="/reservations?tab=all&balance=due" className="mt-auto pt-3 text-sm font-semibold text-[#fdba74] hover:text-[#fed7aa]">
              See balances →
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Stat({ value, label, href }: { value: number; label: string; href: string }) {
  return (
    <Link href={href} className="min-w-32 rounded-[18px] border border-slate-200 bg-white px-5 py-3.5 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900">
      <div className="font-display text-3xl tabular-nums">{value}</div>
      <div className="text-sm text-slate-600 dark:text-slate-300">{label}</div>
    </Link>
  );
}

function ArrivalCard({ r, photo, place, due }: { r: ReservationRow; photo: string | null; place: string | null; due: number | null }) {
  const guests = r.adults + r.children;
  const tag =
    due && due > 0
      ? { text: `${formatMoney(due, r.currency)} due`, cls: "bg-brand-100 text-brand-800" }
      : r.source === "direct" || r.source === "phone" || r.source === "email" || r.source === "website" || r.source === "walk_in"
        ? { text: due === 0 ? "Paid" : SOURCE_LABELS[r.source as ReservationSource], cls: "bg-emerald-100 text-emerald-800" }
        : { text: SOURCE_LABELS[r.source as ReservationSource] ?? r.source, cls: "bg-indigo-100 text-indigo-800" };
  return (
    <article className="flex flex-col overflow-hidden rounded-[22px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- Supabase public storage URL
        <img src={photo} alt="" className="h-44 w-full object-cover" />
      ) : (
        <div className="h-44 w-full bg-slate-100 dark:bg-slate-800" />
      )}
      <div className="flex flex-col gap-1.5 p-5">
        <span className="truncate text-xs text-slate-500">
          {r.unit && r.unit_id !== r.listing_id ? r.unit.internal_name : r.listing?.internal_name}
          {place ? ` · ${place}` : ""}
        </span>
        <span className="font-display text-xl">{guestName(r.guest, r.kind)}</span>
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {formatDate(r.check_in)} → {formatDate(r.check_out)} · {guests} guest{guests === 1 ? "" : "s"}
        </span>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className={cx("rounded-full px-2.5 py-1 text-xs font-medium", tag.cls)}>{tag.text}</span>
          <Link href={`/reservations/${r.id}`} className="text-sm font-semibold text-brand-700 hover:text-brand-800">
            {r.stay_status === "checked_in" ? "Open →" : "Check in →"}
          </Link>
        </div>
      </div>
    </article>
  );
}
