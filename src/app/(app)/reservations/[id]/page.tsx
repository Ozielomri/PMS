import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ActionForm } from "@/components/action-form";
import { Alert, Card, Field, Input, Select, Skeleton, cx, formatDateTime } from "@/components/ui";
import { requireAuthContext, type AuthContext, type MembershipSummary } from "@/lib/auth/context";
import { addDays, localToday } from "@/lib/calendar/dates";
import { formatMoney } from "@/lib/properties/money";
import { guestName } from "@/lib/reservations/list";
import { STAY_LABELS, STAY_TRANSITIONS, isChannelSource, isFinal, type ReservationStatus, type StayStatus } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { addLine, addNote, changeStatus, reassignUnitForm, recordPayment, setStayStatus, updateDetails, updateGuest } from "../actions";
import { LinkButton, SourceDot, StatusBadge, StayDates, formatDate } from "../_components/bits";
import { openReservationConversation } from "../../inbox/actions";
import { ConversationView } from "../../inbox/_components/conversation-view";
import { InboxLive } from "../../inbox/_components/inbox-live";
import { CancelPanel, DownloadFile, FileUpload, MergeGuest } from "./detail-client";

export const metadata: Metadata = { title: "Reservation" };

const TABS = [
  ["overview", "Overview"],
  ["guest", "Guest"],
  ["financials", "Financials"],
  ["messages", "Messages"],
  ["tasks", "Tasks"],
  ["notes", "Notes & files"],
  ["activity", "Activity"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function ReservationPage({ params, searchParams }: PageProps<"/reservations/[id]">) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Reservation params={params} searchParams={searchParams} />
    </Suspense>
  );
}

interface Detail {
  id: string;
  account_id: string;
  code: string;
  kind: "guest" | "owner_stay";
  status: ReservationStatus;
  stay_status: StayStatus | null;
  source: string;
  channel_reservation_id: string | null;
  listing_id: string;
  unit_id: string | null;
  guest_id: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  currency: string;
  cancellation_policy: string;
  approval_deadline: string | null;
  eta: string | null;
  etd: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  status_reason: string | null;
  refund_percent: number | null;
  tags: string[];
  created_at: string;
  guest: { id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; notes: string | null; tags: string[] } | null;
  listing: { id: string; internal_name: string; timezone: string; type: string; parent_id: string | null } | null;
  unit: { id: string; internal_name: string; parent_id: string | null } | null;
}

const SELECT =
  "*, guest:guests(id, first_name, last_name, email, phone, notes, tags), " +
  "listing:listings!reservations_listing_id_account_id_fkey(id, internal_name, timezone, type, parent_id), " +
  "unit:listings!reservations_unit_id_account_id_fkey(id, internal_name, parent_id)";

async function Reservation({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const ctx = await requireAuthContext({ permission: "reservations.view", returnTo: `/reservations/${id}` });
  const sp = await searchParams;
  const tab: Tab = (TABS.map((t) => t[0]) as string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "overview";
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const { data: r } = await supabase.from("reservations").select(SELECT).eq("id", id).maybeSingle<Detail>();
  if (!r) notFound();

  const channel = isChannelSource(r.source);
  const tz = r.listing?.timezone ?? "America/New_York";
  const canEdit = ctx.can("reservations.edit");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">
            <Link href="/reservations" className="hover:underline">
              Reservations
            </Link>{" "}
            / <span className="font-mono">{r.code}</span>
          </p>
          <h1 className="mt-1 text-xl font-semibold">
            {guestName(r.guest, r.kind)} · {r.listing?.internal_name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={r.status} stay={r.stay_status} />
            <SourceDot source={r.source} />
            <StayDates checkIn={r.check_in} checkOut={r.check_out} nights={r.nights} />
          </div>
        </div>
        <StatusActions r={r} canEdit={canEdit} canCreate={ctx.can("reservations.create")} />
      </div>

      {channel ? (
        <div className="mb-4">
          <Alert>
            This booking came from the channel (code {r.channel_reservation_id}). Dates, guests and cancellation are changed on the channel; the PMS follows.
          </Alert>
        </div>
      ) : null}
      {r.status === "reserved" && r.approval_deadline ? (
        <div className="mb-4">
          <Alert>Waiting for approval until {formatDateTime(r.approval_deadline, tz)}. If nobody approves it by then, it expires and the nights are freed.</Alert>
        </div>
      ) : null}

      <nav aria-label="Reservation sections" className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.filter(([t]) => t !== "financials" || ctx.can("reservations.view_money")).map(([t, label]) => (
          <Link
            key={t}
            href={`/reservations/${r.id}${t === "overview" ? "" : `?tab=${t}`}`}
            aria-current={tab === t ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === t ? "border-slate-900 font-medium dark:border-slate-100" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? <Overview r={r} canEdit={canEdit} canCancel={ctx.can("reservations.cancel")} canCustomRefund={ctx.can("reservations.manage")} /> : null}
      {tab === "guest" ? <GuestTab r={r} canEdit={canEdit} canMerge={ctx.can("reservations.manage")} /> : null}
      {tab === "financials" && ctx.can("reservations.view_money") ? <Financials r={r} canEdit={canEdit} canManage={ctx.can("reservations.manage")} /> : null}
      {tab === "messages" ? <MessagesTab r={r} ctx={ctx} tz={tz} /> : null}
      {tab === "tasks" ? (
        <Card title="Tasks">
          <p className="text-sm text-slate-500">Cleaning and other tasks for this stay appear here once tasks are built (step 8).</p>
        </Card>
      ) : null}
      {tab === "notes" ? <NotesTab r={r} canEdit={canEdit} /> : null}
      {tab === "activity" ? <ActivityTab r={r} tz={tz} /> : null}
    </>
  );
}

function StatusActions({ r, canEdit, canCreate }: { r: Detail; canEdit: boolean; canCreate: boolean }) {
  if (!canEdit) return null;
  const f = { reservationId: r.id };
  const channel = isChannelSource(r.source);
  const final = isFinal(r.status);
  return (
    <div className="flex flex-wrap items-start gap-2">
      {r.status === "inquiry" ? (
        <>
          <ActionForm action={changeStatus} fields={{ ...f, to: "confirmed" }} label="Confirm" variant="primary" />
          <ActionForm action={changeStatus} fields={{ ...f, to: "reserved" }} label="Hold as request" />
          <ActionForm action={changeStatus} fields={{ ...f, to: "closed" }} label="Close inquiry" variant="ghost" confirm="Close this inquiry?" />
        </>
      ) : null}
      {r.status === "reserved" ? (
        <>
          <ActionForm action={changeStatus} fields={{ ...f, to: "confirmed" }} label="Approve" variant="primary" />
          <ActionForm action={changeStatus} fields={{ ...f, to: "declined" }} label="Decline" variant="danger" confirm="Decline this request? The nights are freed." />
        </>
      ) : null}
      {r.stay_status
        ? STAY_TRANSITIONS[r.stay_status].map((to) => (
            <ActionForm
              key={to}
              action={setStayStatus}
              fields={{ ...f, to }}
              label={to === "checked_in" ? "Check in" : to === "checked_out" ? "Check out" : `Mark ${STAY_LABELS[to].toLowerCase()}`}
              variant={to === "no_show" ? "ghost" : "secondary"}
              confirm={to === "no_show" ? "Mark the guest as a no-show?" : undefined}
            />
          ))
        : null}
      {!final && !channel && r.stay_status !== "checked_in" && r.stay_status !== "checked_out" ? <LinkButton href={`/reservations/${r.id}/alter`}>Change dates or guests</LinkButton> : null}
      {canCreate && r.kind === "guest" && final ? (
        <LinkButton href={`/reservations/new?listing=${r.listing_id}`}>Book again</LinkButton>
      ) : null}
    </div>
  );
}

async function Overview({ r, canEdit, canCancel, canCustomRefund }: { r: Detail; canEdit: boolean; canCancel: boolean; canCustomRefund: boolean }) {
  const supabase = await createClient();
  // CAL-11: a multi-unit booking can move to another free unit of the same multi-unit.
  const parentId = r.listing?.type === "multi_parent" ? r.listing.id : r.unit?.parent_id ?? r.listing?.parent_id ?? null;
  const { data: siblings } = parentId
    ? await supabase.from("listings").select("id, internal_name").eq("parent_id", parentId).eq("status", "active").order("internal_name").returns<{ id: string; internal_name: string }[]>()
    : { data: [] as { id: string; internal_name: string }[] };
  const otherUnits = (siblings ?? []).filter((s) => s.id !== r.unit_id);
  const holdsNights = r.status === "reserved" || r.status === "confirmed";
  const channel = isChannelSource(r.source);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Stay">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Item label="Check-in">{formatDate(r.check_in, true)}</Item>
            <Item label="Check-out">{formatDate(r.check_out, true)}</Item>
            <Item label="Listing">
              <Link href={`/properties/${r.listing_id}`} className="underline-offset-2 hover:underline">
                {r.listing?.internal_name}
              </Link>
            </Item>
            <Item label="Unit">{r.unit && r.unit_id !== r.listing_id ? r.unit.internal_name : "—"}</Item>
            <Item label="Guests">
              {r.adults} adult{r.adults === 1 ? "" : "s"}
              {r.children ? `, ${r.children} child${r.children === 1 ? "" : "ren"}` : ""}
              {r.infants ? `, ${r.infants} infant${r.infants === 1 ? "" : "s"}` : ""}
              {r.pets ? `, ${r.pets} pet${r.pets === 1 ? "" : "s"}` : ""}
            </Item>
            <Item label="Cancellation policy">{r.cancellation_policy}</Item>
            <Item label="Created">{formatDateTime(r.created_at, r.listing?.timezone)}</Item>
            {r.status_reason ? <Item label="Status note">{r.status_reason}</Item> : null}
            {r.canceled_by ? <Item label="Canceled">{`By ${r.canceled_by}${r.refund_percent !== null ? ` · ${r.refund_percent} % refundable` : ""}`}</Item> : null}
          </dl>
        </Card>
        {canEdit && !isFinal(r.status) ? (
          <Card title="Arrival and tags">
            <ActionForm action={updateDetails} fields={{ reservationId: r.id }} label="Save" className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Expected arrival" htmlFor="eta">
                  <Input id="eta" name="eta" type="time" defaultValue={r.eta?.slice(0, 5) ?? ""} />
                </Field>
                <Field label="Expected departure" htmlFor="etd">
                  <Input id="etd" name="etd" type="time" defaultValue={r.etd?.slice(0, 5) ?? ""} />
                </Field>
                <Field label="Tags" htmlFor="tags" hint="Comma separated">
                  <Input id="tags" name="tags" defaultValue={r.tags.join(", ")} />
                </Field>
              </div>
            </ActionForm>
          </Card>
        ) : (
          <Card title="Arrival and tags">
            <p className="text-sm">
              ETA {r.eta?.slice(0, 5) ?? "—"} · ETD {r.etd?.slice(0, 5) ?? "—"} · Tags {r.tags.length ? r.tags.join(", ") : "—"}
            </p>
          </Card>
        )}
      </div>
      <div className="space-y-6">
        {canEdit && holdsNights && otherUnits.length ? (
          <Card title="Move to another unit" description="Same multi-unit, same dates. The price does not change.">
            <ActionForm action={reassignUnitForm} fields={{ reservationId: r.id }} label="Move" className="space-y-2">
              <Select name="unitId" aria-label="Unit" required defaultValue="">
                <option value="" disabled>
                  Choose a unit
                </option>
                {otherUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.internal_name}
                  </option>
                ))}
              </Select>
            </ActionForm>
          </Card>
        ) : null}
        {canCancel && r.status === "confirmed" && !channel && r.stay_status === "upcoming" ? (
          <Card title="Cancel">
            <CancelPanel reservationId={r.id} policy={r.cancellation_policy} canCustom={canCustomRefund} currency={r.currency} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

async function GuestTab({ r, canEdit, canMerge }: { r: Detail; canEdit: boolean; canMerge: boolean }) {
  if (r.kind === "owner_stay" || !r.guest) {
    return (
      <Card>
        <p className="text-sm text-slate-500">Owner stays have no guest.</p>
      </Card>
    );
  }
  const g = r.guest;
  const supabase = await createClient();
  const { data: history } = await supabase
    .from("reservations")
    .select("id, code, status, check_in, check_out, nights, listing:listings!reservations_listing_id_account_id_fkey(internal_name)")
    .eq("guest_id", g.id)
    .order("check_in", { ascending: false })
    .limit(20)
    .returns<{ id: string; code: string; status: ReservationStatus; check_in: string; check_out: string; nights: number; listing: { internal_name: string } | null }[]>();
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Guest profile" className="lg:col-span-2">
        {canEdit ? (
          <ActionForm action={updateGuest} fields={{ guestId: g.id, reservationId: r.id }} label="Save guest" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="g_first">
                <Input id="g_first" name="first_name" defaultValue={g.first_name} required maxLength={100} />
              </Field>
              <Field label="Last name" htmlFor="g_last">
                <Input id="g_last" name="last_name" defaultValue={g.last_name ?? ""} maxLength={100} />
              </Field>
              <Field label="Email" htmlFor="g_email">
                <Input id="g_email" name="email" type="email" defaultValue={g.email ?? ""} />
              </Field>
              <Field label="Phone" htmlFor="g_phone">
                <Input id="g_phone" name="phone" type="tel" defaultValue={g.phone ?? ""} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Tags" htmlFor="g_tags" hint="Comma separated">
                  <Input id="g_tags" name="tags" defaultValue={g.tags.join(", ")} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Notes" htmlFor="g_notes">
                  <textarea id="g_notes" name="notes" rows={3} defaultValue={g.notes ?? ""} maxLength={5000} className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
                </Field>
              </div>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm">
            {guestName(g, "guest")} · {g.email ?? "no email"} · {g.phone ?? "no phone"}
          </p>
        )}
      </Card>
      <div className="space-y-6">
        <Card title="Stays">
          <ul className="space-y-2 text-sm">
            {(history ?? []).map((h) => (
              <li key={h.id}>
                <Link href={`/reservations/${h.id}`} className={cx("font-mono underline-offset-2 hover:underline", h.id === r.id && "font-semibold")}>
                  {h.code}
                </Link>{" "}
                · {h.listing?.internal_name} · {formatDate(h.check_in)} · <StatusBadge status={h.status} />
              </li>
            ))}
          </ul>
        </Card>
        {canMerge ? (
          <Card title="Merge duplicate" description="Moves the other guest's reservations here and retires the duplicate.">
            <MergeGuest keepId={g.id} reservationId={r.id} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

interface Line {
  id: number;
  kind: string;
  label: string;
  quantity: number;
  unit_amount_cents: number | null;
  amount_cents: number;
  source: string;
  reason: string | null;
  created_at: string;
}

async function Financials({ r, canEdit, canManage }: { r: Detail; canEdit: boolean; canManage: boolean }) {
  const supabase = await createClient();
  const [{ data: lines }, { data: payments }, { data: balance }] = await Promise.all([
    supabase.from("reservation_lines").select("id, kind, label, quantity, unit_amount_cents, amount_cents, source, reason, created_at").eq("reservation_id", r.id).order("id").returns<Line[]>(),
    supabase.from("reservation_payments").select("id, amount_cents, method, received_at, reference, note").eq("reservation_id", r.id).order("received_at").returns<{ id: number; amount_cents: number; method: string; received_at: string; reference: string | null; note: string | null }[]>(),
    supabase.from("reservation_balances").select("guest_total_cents, commission_cents, host_payout_cents, paid_cents, balance_due_cents").eq("reservation_id", r.id).maybeSingle<{ guest_total_cents: number; commission_cents: number; host_payout_cents: number; paid_cents: number; balance_due_cents: number }>(),
  ]);
  const m = (c: number | null | undefined) => formatMoney(c, r.currency);
  const guestLines = (lines ?? []).filter((l) => l.kind !== "commission");
  const commission = (lines ?? []).filter((l) => l.kind === "commission");
  const locked = r.check_out < addDays(localToday(r.listing?.timezone ?? "America/New_York"), -30);
  const open = !["declined", "expired", "closed", "canceled"].includes(r.status);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Charges" description={locked ? "Locked: more than 30 days after check-out. Only adjustments with a reason can be added." : "Lines are never edited; corrections are added as adjustments."}>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {guestLines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5">
                    {l.label}
                    {l.quantity > 1 && l.unit_amount_cents !== null ? <span className="text-slate-400"> ({l.quantity} × {m(l.unit_amount_cents)})</span> : null}
                    {l.reason ? <div className="text-xs text-slate-500">{l.reason}</div> : null}
                  </td>
                  <td className="py-1.5 text-xs text-slate-400">{l.source !== "pms" ? l.source : ""}</td>
                  <td className={cx("py-1.5 text-right tabular-nums", l.amount_cents < 0 && "text-emerald-700 dark:text-emerald-400")}>{m(l.amount_cents)}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2">Guest total</td>
                <td />
                <td className="py-2 text-right tabular-nums">{m(balance?.guest_total_cents)}</td>
              </tr>
              {commission.length ? (
                <>
                  {commission.map((l) => (
                    <tr key={l.id} className="text-slate-500">
                      <td className="py-1.5">{l.label}</td>
                      <td />
                      <td className="py-1.5 text-right tabular-nums">−{m(l.amount_cents)}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-2">Host payout</td>
                    <td />
                    <td className="py-2 text-right tabular-nums">{m(balance?.host_payout_cents)}</td>
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </Card>
        <Card title="Payments" description="Recorded by hand; the PMS takes no payments in this phase.">
          {(payments ?? []).length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : null}
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(payments ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="py-1.5">{formatDateTime(p.received_at, r.listing?.timezone)}</td>
                  <td className="py-1.5">
                    {p.amount_cents < 0 ? "Refund" : "Payment"} · {p.method.replace(/_/g, " ")}
                    {p.reference ? <span className="text-slate-500"> · {p.reference}</span> : null}
                    {p.note ? <div className="text-xs text-slate-500">{p.note}</div> : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{m(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <div className="space-y-6">
        <Card title="Balance">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt>Total</dt>
            <dd className="text-right tabular-nums">{m(balance?.guest_total_cents)}</dd>
            <dt>Paid</dt>
            <dd className="text-right tabular-nums">{m(balance?.paid_cents)}</dd>
            <dt className="font-medium">Balance due</dt>
            <dd className={cx("text-right font-medium tabular-nums", (balance?.balance_due_cents ?? 0) > 0 && "text-amber-700 dark:text-amber-400")}>{m(balance?.balance_due_cents)}</dd>
          </dl>
        </Card>
        {canEdit ? (
          <Card title="Record payment or refund">
            <ActionForm action={recordPayment} fields={{ reservationId: r.id }} label="Record" className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Select name="direction" aria-label="Type" defaultValue="payment">
                  <option value="payment">Payment</option>
                  <option value="refund">Refund</option>
                </Select>
                <Input name="amount" inputMode="decimal" placeholder="Amount" aria-label="Amount" required />
              </div>
              <Select name="method" aria-label="Method" defaultValue="card_external">
                <option value="card_external">Card (outside the PMS)</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="channel_collected">Collected by the channel</option>
                <option value="other">Other</option>
              </Select>
              <Input name="received_on" type="date" aria-label="Received on" />
              <Input name="reference" placeholder="Reference" aria-label="Reference" maxLength={200} />
              <Input name="note" placeholder="Note" aria-label="Note" maxLength={1000} />
            </ActionForm>
          </Card>
        ) : null}
        {canEdit && open && !locked ? (
          <Card title="Add extra" description="E.g. early check-in, late check-out.">
            <ActionForm action={addLine} fields={{ reservationId: r.id, kind: "extra" }} label="Add extra" className="space-y-3">
              <Input name="label" placeholder="Description" aria-label="Description" required maxLength={200} />
              <div className="grid grid-cols-2 gap-2">
                <Input name="amount" inputMode="decimal" placeholder="Unit price" aria-label="Unit price" required />
                <Input name="quantity" type="number" min={1} max={1000} defaultValue={1} aria-label="Quantity" />
              </div>
            </ActionForm>
          </Card>
        ) : null}
        {canManage ? (
          <Card title="Adjustment" description="A charge or credit with a reason; logged in the activity.">
            <ActionForm action={addLine} fields={{ reservationId: r.id, kind: "adjustment" }} label="Add adjustment" className="space-y-3">
              <Input name="label" placeholder="Description" aria-label="Description" required maxLength={200} />
              <Input name="amount" inputMode="decimal" placeholder="Amount" aria-label="Amount" required />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="credit" /> This is a credit (reduces the total)
              </label>
              <Input name="reason" placeholder="Reason (required)" aria-label="Reason" required maxLength={1000} />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

async function NotesTab({ r, canEdit }: { r: Detail; canEdit: boolean }) {
  const supabase = await createClient();
  const [{ data: notes }, { data: files }] = await Promise.all([
    supabase.from("reservation_notes").select("id, body, created_at").eq("reservation_id", r.id).order("created_at", { ascending: false }).returns<{ id: string; body: string; created_at: string }[]>(),
    supabase.from("reservation_files").select("id, file_name, size_bytes, created_at").eq("reservation_id", r.id).order("created_at", { ascending: false }).returns<{ id: string; file_name: string; size_bytes: number; created_at: string }[]>(),
  ]);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Internal notes" description="Visible to the team only; notes cannot be edited or deleted.">
        {canEdit ? (
          <ActionForm action={addNote} fields={{ reservationId: r.id }} label="Add note" className="mb-4 space-y-2">
            <textarea name="body" rows={3} required maxLength={10000} aria-label="Note" className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
          </ActionForm>
        ) : null}
        <ul className="space-y-3">
          {(notes ?? []).map((n) => (
            <li key={n.id} className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-1 text-xs text-slate-500">{formatDateTime(n.created_at, r.listing?.timezone)}</p>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Files" description="Private; download links expire after a minute.">
        {canEdit ? <FileUpload reservationId={r.id} accountId={r.account_id} /> : null}
        <ul className="mt-4 space-y-2 text-sm">
          {(files ?? []).map((f) => (
            <li key={f.id} className="flex justify-between gap-2">
              <DownloadFile fileId={f.id} name={f.file_name} />
              <span className="text-slate-500">{Math.max(1, Math.round(f.size_bytes / 1024))} KB</span>
            </li>
          ))}
          {(files ?? []).length === 0 ? <li className="text-slate-500">No files.</li> : null}
        </ul>
      </Card>
    </div>
  );
}

async function ActivityTab({ r, tz }: { r: Detail; tz: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("reservation_activity")
    .select("id, kind, summary, actor_type, occurred_at")
    .eq("reservation_id", r.id)
    .order("id", { ascending: false })
    .limit(200)
    .returns<{ id: number; kind: string; summary: string; actor_type: string; occurred_at: string }[]>();
  return (
    <Card title="Activity" description="Every change to this reservation, newest first.">
      <ol className="space-y-3 text-sm">
        {(data ?? []).map((a) => (
          <li key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 pb-2 last:border-0 dark:border-slate-800">
            <span>
              <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{a.kind}</span>
              {a.summary}
            </span>
            <span className="text-xs text-slate-500">
              {formatDateTime(a.occurred_at, tz)} · {a.actor_type}
            </span>
          </li>
        ))}
        {(data ?? []).length === 0 ? <li className="text-slate-500">No activity yet.</li> : null}
      </ol>
    </Card>
  );
}

/** INB: the guest conversation of this reservation (same thread and composer as the inbox). */
async function MessagesTab({ r, ctx, tz }: { r: Detail; ctx: AuthContext & { active: MembershipSummary }; tz: string }) {
  if (!ctx.can("inbox.view")) {
    return (
      <Card title="Messages">
        <p className="text-sm text-slate-500">You do not have access to guest messages.</p>
      </Card>
    );
  }
  if (r.kind === "owner_stay" || !r.guest_id) {
    return (
      <Card title="Messages">
        <p className="text-sm text-slate-500">Owner stays have no guest conversation.</p>
      </Card>
    );
  }
  const supabase = await createClient();
  const { data: conv } = await supabase.from("conversations").select("id").eq("reservation_id", r.id).eq("guest_id", r.guest_id).maybeSingle<{ id: string }>();
  if (!conv) {
    return (
      <Card title="Messages" description="No messages with this guest yet.">
        {ctx.can("inbox.reply") ? <ActionForm action={openReservationConversation} fields={{ reservationId: r.id }} label="Start conversation" variant="primary" /> : null}
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <InboxLive accountId={r.account_id} />
        <Link href={`/inbox?tab=all&c=${conv.id}`} className="text-sm text-brand-700 underline-offset-2 hover:underline dark:text-brand-500">
          Open in inbox
        </Link>
      </div>
      <ConversationView ctx={ctx} conversationId={conv.id} timeZone={tz} />
    </div>
  );
}
