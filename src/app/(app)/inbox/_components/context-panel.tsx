import Link from "next/link";

import { ActionForm } from "@/components/action-form";
import { Badge, Input } from "@/components/ui";
import type { AuthContext, MembershipSummary } from "@/lib/auth/context";
import { emailProviderName } from "@/lib/inbox/config";
import { formatDuration } from "@/lib/inbox/format";
import { conversationVariables, loadConversationContext } from "@/lib/inbox/server";
import { formatMoney } from "@/lib/properties/money";
import { STATUS_LABELS, type ReservationStatus, type StayStatus } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

import { changeStatus } from "../../reservations/actions";
import { StatusBadge, formatDate } from "../../reservations/_components/bits";
import { setConversationTags, simulateGuestReply } from "../actions";

type Ctx = AuthContext & { active: MembershipSummary };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-200 pb-4 last:border-0 dark:border-slate-800">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/** INB-07 context panel: reservation with status actions, guest and history, listing info and custom fields. */
export async function ContextPanel({ ctx, conversationId }: { ctx: Ctx; conversationId: string }) {
  const supabase = await createClient();
  const conv = await loadConversationContext(supabase, conversationId);
  if (!conv) return null;
  const r = conv.reservation;
  const g = conv.guest;
  const canEditReservation = ctx.can("reservations.edit");

  const [vars, { data: fields }, { data: history }, { data: balance }, { data: response }] = await Promise.all([
    ctx.can("inbox.reply") ? conversationVariables(supabase, conv) : Promise.resolve({} as Record<string, string>),
    supabase.from("custom_fields").select("key, label, field_type").eq("account_id", conv.conversation.account_id).is("archived_at", null).order("position").returns<{ key: string; label: string; field_type: string }[]>(),
    g
      ? supabase
          .from("reservations")
          .select("id, code, status, check_in, listing:listings!reservations_listing_id_account_id_fkey(internal_name)")
          .eq("guest_id", g.id)
          .order("check_in", { ascending: false })
          .limit(6)
          .returns<{ id: string; code: string; status: ReservationStatus; check_in: string; listing: { internal_name: string } | null }[]>()
      : Promise.resolve({ data: [] as { id: string; code: string; status: ReservationStatus; check_in: string; listing: { internal_name: string } | null }[] }),
    r && ctx.can("reservations.view_money")
      ? supabase.from("reservation_balances").select("guest_total_cents, balance_due_cents").eq("reservation_id", r.id).maybeSingle<{ guest_total_cents: number; balance_due_cents: number }>()
      : Promise.resolve({ data: null }),
    supabase.from("inbox_conversation_response").select("first_response_seconds, avg_seconds, replies").eq("conversation_id", conversationId).maybeSingle<{ first_response_seconds: number | null; avg_seconds: number | null; replies: number }>(),
  ]);

  const f = { reservationId: r?.id ?? "" };
  return (
    <aside aria-label="Context" className="space-y-4 text-sm">
      <Section title="Reservation">
        {r ? (
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-2">
              <Link href={`/reservations/${r.id}`} className="font-mono underline-offset-2 hover:underline">
                {r.code}
              </Link>
              <StatusBadge status={r.status as ReservationStatus} stay={r.stay_status as StayStatus | null} />
            </p>
            <p>
              {formatDate(r.check_in, true)} → {formatDate(r.check_out, true)} · {r.nights} night{r.nights === 1 ? "" : "s"}
            </p>
            <p className="text-slate-500">
              {r.listing?.internal_name} · {r.adults + r.children} guest{r.adults + r.children === 1 ? "" : "s"}
              {r.pets ? ` · ${r.pets} pet${r.pets === 1 ? "" : "s"}` : ""}
              {r.eta ? ` · ETA ${r.eta.slice(0, 5)}` : ""}
            </p>
            {balance ? (
              <p>
                Total {formatMoney(balance.guest_total_cents, "USD")} ·{" "}
                <span className={balance.balance_due_cents > 0 ? "text-amber-700 dark:text-amber-400" : undefined}>due {formatMoney(balance.balance_due_cents, "USD")}</span>
              </p>
            ) : null}
            {canEditReservation && r.status === "reserved" ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <ActionForm action={changeStatus} fields={{ ...f, to: "confirmed" }} label="Approve" variant="primary" />
                <ActionForm action={changeStatus} fields={{ ...f, to: "declined" }} label="Decline" variant="danger" confirm="Decline this request? The nights are freed." />
              </div>
            ) : null}
            {ctx.can("reservations.create") && r.status === "inquiry" ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <ActionForm action={changeStatus} fields={{ ...f, to: "confirmed" }} label="Confirm booking" variant="primary" />
                <ActionForm action={changeStatus} fields={{ ...f, to: "closed" }} label="Close inquiry" variant="ghost" confirm="Close this inquiry?" />
              </div>
            ) : null}
            {r.status === "reserved" && r.approval_deadline ? <p className="text-xs text-slate-500">Approve before {new Date(r.approval_deadline).toLocaleString("en-US", { timeZone: r.listing?.timezone ?? "UTC" })}.</p> : null}
          </div>
        ) : (
          <div className="space-y-2 text-slate-500">
            <p>Not linked to a reservation. It attaches automatically when a booking for this guest&apos;s email is created.</p>
            {ctx.can("reservations.create") ? (
              <Link href="/reservations/new" className="text-brand-700 underline-offset-2 hover:underline dark:text-brand-500">
                Create a reservation or inquiry
              </Link>
            ) : null}
          </div>
        )}
      </Section>

      <Section title="Guest">
        <p className="font-medium">{g ? [g.first_name, g.last_name].filter(Boolean).join(" ") : (conv.conversation.contact_name ?? "Unknown")}</p>
        <p className="break-all text-slate-500">{conv.conversation.contact_email ?? g?.email ?? "No email"}</p>
        {g?.phone ? <p className="text-slate-500">{g.phone}</p> : null}
        {g?.language ? <p className="text-slate-500">Language: {g.language}</p> : null}
        {g?.tags?.length ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {g.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </p>
        ) : null}
        {g?.notes ? <p className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{g.notes}</p> : null}
        {(history ?? []).length > 1 ? (
          <ul className="mt-2 space-y-1">
            {(history ?? []).map((h) => (
              <li key={h.id} className="text-xs">
                <Link href={`/reservations/${h.id}`} className="font-mono underline-offset-2 hover:underline">
                  {h.code}
                </Link>{" "}
                · {formatDate(h.check_in)} · {h.listing?.internal_name} · {STATUS_LABELS[h.status]}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {r ? (
        <Section title="Listing">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {vars["listing.check_in_from"] ? (
              <>
                <dt className="text-slate-500">Check-in</dt>
                <dd>
                  {vars["listing.check_in_from"]}
                  {vars["listing.check_in_to"] ? `–${vars["listing.check_in_to"]}` : ""}
                </dd>
              </>
            ) : null}
            {vars["listing.check_out_by"] ? (
              <>
                <dt className="text-slate-500">Check-out</dt>
                <dd>by {vars["listing.check_out_by"]}</dd>
              </>
            ) : null}
            {vars["listing.address"] ? (
              <>
                <dt className="text-slate-500">Address</dt>
                <dd>{[vars["listing.address"], vars["listing.city"]].filter(Boolean).join(", ")}</dd>
              </>
            ) : null}
            {(fields ?? []).map((cf) =>
              vars[`custom.${cf.key}`] ? (
                <div key={cf.key} className="contents">
                  <dt className="text-slate-500">
                    {cf.field_type === "secret" ? "🔒 " : ""}
                    {cf.label}
                  </dt>
                  <dd className={cf.field_type === "secret" ? "font-mono" : undefined}>{vars[`custom.${cf.key}`]}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </Section>
      ) : null}

      <Section title="Response time">
        <p>
          First reply {formatDuration(response?.first_response_seconds ?? null)} · average {formatDuration(response?.avg_seconds ?? null)}
        </p>
      </Section>

      {ctx.can("inbox.manage") ? (
        <Section title="Tags">
          <ActionForm action={setConversationTags} fields={{ conversationId }} label="Save tags" variant="ghost" className="space-y-2">
            <Input name="tags" defaultValue={conv.conversation.tags.join(", ")} aria-label="Tags" placeholder="e.g. vip, late-arrival" />
          </ActionForm>
        </Section>
      ) : null}

      <Section title="Automations and tasks">
        <p className="text-slate-500">Scheduled auto-messages arrive with automations (step 7); tasks for this stay with step 8.</p>
      </Section>

      {ctx.can("inbox.manage") && emailProviderName() === "log" ? (
        <Section title="Development">
          <p className="mb-2 text-xs text-slate-500">The development email adapter sends nothing. Simulate the guest replying by email (goes through the real inbound matching).</p>
          <ActionForm action={simulateGuestReply} fields={{ conversationId }} label="Simulate guest reply" variant="ghost" className="space-y-2">
            <Input name="text" aria-label="Guest message" placeholder="Hi! What time can we check in?" required maxLength={2000} />
          </ActionForm>
        </Section>
      ) : null}
    </aside>
  );
}
