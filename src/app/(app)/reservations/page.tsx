import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Button, Card, Input, PageHeader, Select, Skeleton, cx } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { formatMoney } from "@/lib/properties/money";
import { LIST_TABS, TAB_LABELS, filtersToQuery, parseFilters } from "@/lib/reservations/filters";
import { accountToday, guestName, listReservations } from "@/lib/reservations/list";
import { RESERVATION_STATUSES, SOURCES, SOURCE_LABELS, STATUS_LABELS, STAY_LABELS, STAY_STATUSES } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { deleteView, saveView } from "./actions";
import { LinkButton, SourceDot, StatusBadge, StayDates } from "./_components/bits";

export const metadata: Metadata = { title: "Reservations" };

const PAGE_SIZE = 50;

export default function ReservationsPage({ searchParams }: PageProps<"/reservations">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Reservations searchParams={searchParams} />
    </Suspense>
  );
}

async function Reservations({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuthContext({ permission: "reservations.view", returnTo: "/reservations" });
  const f = parseFilters(await searchParams);
  const supabase = await createClient();
  const accountId = ctx.active.accountId;
  const withMoney = ctx.can("reservations.view_money");

  // RES-04: requests past their deadline expire before anyone looks at the list.
  await supabase.rpc("expire_overdue_reservations");
  const { today } = await accountToday(supabase, accountId);

  const [{ rows, total, balances }, { data: listings }, { data: views }] = await Promise.all([
    listReservations(supabase, accountId, f, { today, limit: PAGE_SIZE, offset: (f.page - 1) * PAGE_SIZE, withMoney }),
    supabase.from("listings").select("id, internal_name, type").eq("account_id", accountId).neq("status", "archived").order("internal_name").limit(1000).returns<{ id: string; internal_name: string; type: string }[]>(),
    supabase.from("reservation_saved_views").select("id, name, filters, shared, user_id").eq("account_id", accountId).order("name").returns<{ id: string; name: string; filters: { query?: string }; shared: boolean; user_id: string }[]>(),
  ]);

  const query = filtersToQuery({ ...f, page: 1 });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (patch: Partial<typeof f>) => `/reservations?${filtersToQuery({ ...f, ...patch })}`;

  return (
    <>
      <PageHeader
        title="Reservations"
        description={`${total} reservation${total === 1 ? "" : "s"}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={`/reservations/export?${query}`} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              Export CSV
            </a>
            {ctx.can("reservations.create") ? (
              <>
                <LinkButton href="/reservations/quotes">Quotes</LinkButton>
                <LinkButton href="/reservations/new" primary>
                  New reservation
                </LinkButton>
              </>
            ) : null}
          </div>
        }
      />

      <nav aria-label="Quick views" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {LIST_TABS.map((tab) => (
          <Link
            key={tab}
            href={href({ tab, page: 1 })}
            aria-current={f.tab === tab ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              f.tab === tab ? "border-slate-900 font-medium text-slate-900 dark:border-slate-100 dark:text-white" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {TAB_LABELS[tab]}
          </Link>
        ))}
      </nav>

      <Card className="mb-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" role="search" aria-label="Filter reservations">
          <input type="hidden" name="tab" value={f.tab} />
          <div className="sm:col-span-2">
            <label htmlFor="q" className="sr-only">
              Search
            </label>
            <Input id="q" name="q" type="search" defaultValue={f.q} placeholder="Code, guest, email, phone" />
          </div>
          <Select name="listing" defaultValue={f.listing} aria-label="Listing">
            <option value="">All listings</option>
            {(listings ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.internal_name}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={f.status} aria-label="Status">
            <option value="">Any status</option>
            {RESERVATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select name="stay" defaultValue={f.stay} aria-label="Stay status">
            <option value="">Any stay status</option>
            {STAY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STAY_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select name="source" defaultValue={f.source} aria-label="Source">
            <option value="">Any source</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
          <DateRange label="Check-in" from={["ci_from", f.checkInFrom]} to={["ci_to", f.checkInTo]} />
          <DateRange label="Check-out" from={["co_from", f.checkOutFrom]} to={["co_to", f.checkOutTo]} />
          <DateRange label="Created" from={["created_from", f.createdFrom]} to={["created_to", f.createdTo]} />
          <Input name="tag" defaultValue={f.tag} placeholder="Tag" aria-label="Tag" />
          <div className="flex items-center gap-3">
            {withMoney ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="balance" value="due" defaultChecked={f.balanceDue} /> Balance due
              </label>
            ) : null}
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </div>
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
          <span className="text-slate-500">Saved views:</span>
          {(views ?? []).length === 0 ? <span className="text-slate-400">none yet</span> : null}
          {(views ?? []).map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
              <Link href={`/reservations?${v.filters.query ?? ""}`}>{v.name}</Link>
              {v.shared ? <span className="text-xs text-slate-500">(shared)</span> : null}
              {v.user_id === ctx.user.id ? (
                <form action={deleteView}>
                  <input type="hidden" name="viewId" value={v.id} />
                  <button type="submit" aria-label={`Delete view ${v.name}`} className="text-slate-400 hover:text-red-600">
                    ×
                  </button>
                </form>
              ) : null}
            </span>
          ))}
          <ActionForm action={saveView} fields={{ query }} label="Save current view" className="ml-auto flex flex-wrap items-center gap-2">
            <Input name="name" placeholder="View name" aria-label="View name" className="w-40" required />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="shared" /> Share with team
            </label>
          </ActionForm>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No reservations match.</p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Guest</th>
                <th className="px-3 py-2">Listing</th>
                <th className="px-3 py-2">Dates</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Source</th>
                {withMoney ? <th className="px-3 py-2 text-right">Total</th> : null}
                {withMoney ? <th className="px-3 py-2 text-right">Balance</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => {
                const b = balances.get(r.id);
                return (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 font-mono">
                      <Link href={`/reservations/${r.id}`} className="underline-offset-2 hover:underline">
                        {r.code}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {guestName(r.guest, r.kind)}
                      <div className="text-xs text-slate-500">
                        {r.adults + r.children} guest{r.adults + r.children === 1 ? "" : "s"}
                        {r.pets ? ` · ${r.pets} pet${r.pets === 1 ? "" : "s"}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.listing?.internal_name}
                      {r.unit && r.unit_id !== r.listing_id ? <div className="text-xs text-slate-500">{r.unit.internal_name}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      <StayDates checkIn={r.check_in} checkOut={r.check_out} nights={r.nights} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status} stay={r.stay_status} />
                    </td>
                    <td className="px-3 py-2">
                      <SourceDot source={r.source} />
                    </td>
                    {withMoney ? <td className="px-3 py-2 text-right tabular-nums">{formatMoney(b?.guest_total_cents, r.currency)}</td> : null}
                    {withMoney ? (
                      <td className={cx("px-3 py-2 text-right tabular-nums", (b?.balance_due_cents ?? 0) > 0 && "text-amber-700 dark:text-amber-400")}>
                        {formatMoney(b?.balance_due_cents, r.currency)}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {f.page > 1 ? <Link href={href({ page: f.page - 1 })}>← Previous</Link> : <span />}
          <span className="text-slate-500">
            Page {f.page} of {pages}
          </span>
          {f.page < pages ? <Link href={href({ page: f.page + 1 })}>Next →</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}

function DateRange({ label, from, to }: { label: string; from: [string, string]; to: [string, string] }) {
  return (
    <fieldset className="flex items-center gap-1 sm:col-span-2 lg:col-span-2">
      <legend className="sr-only">{label}</legend>
      <span className="w-20 shrink-0 text-xs text-slate-500">{label}</span>
      <Input type="date" name={from[0]} defaultValue={from[1]} aria-label={`${label} from`} />
      <span className="text-slate-400">–</span>
      <Input type="date" name={to[0]} defaultValue={to[1]} aria-label={`${label} to`} />
    </fieldset>
  );
}
