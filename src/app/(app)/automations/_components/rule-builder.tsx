"use client";

import { useActionState, useRef, useState, useTransition } from "react";

import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { describeTiming, isTimeAnchored, joinOffset, splitOffset, TRIGGER_LABELS, TRIGGERS, type OffsetUnit, type RulePayload, type Trigger } from "@/lib/automations/rules";
import { VARIABLE_CATALOG } from "@/lib/inbox/variables";
import { SOURCE_LABELS, SOURCES } from "@/lib/reservations/status";

import { previewRule, saveRule, sendTest, type PreviewResult } from "../actions";

const LANGUAGES: [string, string][] = [
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["he", "Hebrew"],
];

const textarea =
  "block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

export function RuleBuilder({
  ruleId,
  initial,
  listings,
  samples,
  canEdit,
}: {
  ruleId: string | null;
  initial: RulePayload;
  listings: { id: string; name: string }[];
  samples: { id: string; label: string }[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveRule, null);
  const formRef = useRef<HTMLFormElement>(null);
  const offset = splitOffset(initial.offset_minutes);
  const [trigger, setTrigger] = useState<Trigger>(initial.trigger);
  const [amount, setAmount] = useState(offset.amount);
  const [unit, setUnit] = useState<OffsetUnit>(offset.unit);
  const [direction, setDirection] = useState(offset.direction);
  const [atTime, setAtTime] = useState(initial.at_time?.slice(0, 5) ?? "");
  const [kind, setKind] = useState(initial.action.kind);
  const msg = initial.action.kind === "message" ? initial.action : null;
  const [recipient, setRecipient] = useState(msg?.recipient ?? "guest");
  const [body, setBody] = useState(msg?.body ?? "");
  const [variants, setVariants] = useState<Record<string, string>>(msg?.variants ?? {});
  const [tab, setTab] = useState<string>("default");
  const [sample, setSample] = useState(samples[0]?.id ?? "");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok?: boolean; error?: string; message?: string } | null>(null);
  const [checking, startCheck] = useTransition();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const c = initial.conditions;

  const timing = describeTiming({ trigger, offset_minutes: joinOffset(amount || 0, unit, isTimeAnchored(trigger) ? direction : "after"), at_time: atTime || null });

  const fields = () => {
    const fd = new FormData(formRef.current!);
    const out: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = out[k] && ["listing_ids", "exclude_listing_ids", "sources"].includes(k) ? `${out[k]},${v}` : v;
    return out;
  };

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    const current = tab === "default" ? body : (variants[tab] ?? "");
    const pos = el?.selectionStart ?? current.length;
    const next = current.slice(0, pos) + token + current.slice(el?.selectionEnd ?? pos);
    if (tab === "default") setBody(next);
    else setVariants({ ...variants, [tab]: next });
  };

  return (
    <form ref={formRef} action={action} className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {ruleId ? <input type="hidden" name="rule_id" value={ruleId} /> : null}
      <input type="hidden" name="starter_key" value={initial.starter_key ?? ""} />
      <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-6">
        <Card title="Name">
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label="Rule name (internal)" htmlFor="name">
              <Input id="name" name="name" defaultValue={initial.name} required maxLength={120} />
            </Field>
            <Field label="Status" htmlFor="status">
              <Select id="status" name="status" defaultValue={initial.status}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="When" description={timing}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trigger" htmlFor="trigger">
              <Select id="trigger" name="trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as Trigger)}>
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Fixed local time (optional)" htmlFor="at_time" hint="In the listing's timezone. With a time, the offset is in days.">
              <Input id="at_time" name="at_time" type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
            </Field>
            <div className="grid grid-cols-3 gap-2 sm:col-span-2">
              <Field label="Offset" htmlFor="offset_amount">
                <Input id="offset_amount" name="offset_amount" type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
              </Field>
              <Field label="Unit" htmlFor="offset_unit">
                <Select id="offset_unit" name="offset_unit" value={atTime ? "days" : unit} onChange={(e) => setUnit(e.target.value as OffsetUnit)} disabled={Boolean(atTime)}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </Select>
                {atTime ? <input type="hidden" name="offset_unit" value="days" /> : null}
              </Field>
              <Field label="Direction" htmlFor="offset_direction">
                <Select id="offset_direction" name="offset_direction" value={isTimeAnchored(trigger) ? direction : "after"} onChange={(e) => setDirection(e.target.value as "before" | "after")} disabled={!isTimeAnchored(trigger)}>
                  <option value="before">before</option>
                  <option value="after">after</option>
                </Select>
                {!isTimeAnchored(trigger) ? <input type="hidden" name="offset_direction" value="after" /> : null}
              </Field>
            </div>
            <Field label="Don't send if more than … hours late (optional)" htmlFor="expire_after_hours" hint="Avoids stale messages after an outage.">
              <Input id="expire_after_hours" name="expire_after_hours" type="number" min={1} max={720} defaultValue={initial.expire_after_hours ?? ""} />
            </Field>
          </div>
        </Card>

        <Card title="For which bookings" description="Leave empty to apply to every guest reservation. Owner stays never get automated messages.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Only these listings" htmlFor="listing_ids">
              <Select id="listing_ids" name="listing_ids" multiple size={5} defaultValue={c.listing_ids ?? []}>
                {listings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Except these listings" htmlFor="exclude_listing_ids">
              <Select id="exclude_listing_ids" name="exclude_listing_ids" multiple size={5} defaultValue={c.exclude_listing_ids ?? []}>
                {listings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Listing tags (any of)" htmlFor="tags" hint="Comma separated">
              <Input id="tags" name="tags" defaultValue={(c.tags ?? []).join(", ")} />
            </Field>
            <Field label="Not tagged" htmlFor="exclude_tags" hint="Comma separated">
              <Input id="exclude_tags" name="exclude_tags" defaultValue={(c.exclude_tags ?? []).join(", ")} />
            </Field>
            <Field label="Sources" htmlFor="sources">
              <Select id="sources" name="sources" multiple size={5} defaultValue={c.sources ?? []}>
                {SOURCES.filter((s) => s !== "owner").map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Guest languages" htmlFor="languages" hint="Codes like en, es. Comma separated.">
              <Input id="languages" name="languages" defaultValue={(c.languages ?? []).join(", ")} />
            </Field>
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:grid-cols-6">
              {(
                [
                  ["min_nights", "Min nights"],
                  ["max_nights", "Max nights"],
                  ["min_guests", "Min guests"],
                  ["max_guests", "Max guests"],
                  ["min_lead_days", "Booked ≥ days ahead"],
                  ["max_lead_days", "Booked ≤ days ahead"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label} htmlFor={k}>
                  <Input id={k} name={k} type="number" min={0} max={1000} defaultValue={c[k] ?? ""} />
                </Field>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Do what">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Action" htmlFor="action_kind">
              <Select id="action_kind" name="action_kind" value={kind} onChange={(e) => setKind(e.target.value as "message" | "agent_draft")}>
                <option value="message">Send a message</option>
                <option value="agent_draft">Ask the AI agent to draft a message (you approve it)</option>
              </Select>
            </Field>
            {kind === "message" ? (
              <Field label="To" htmlFor="recipient">
                <Select id="recipient" name="recipient" value={recipient} onChange={(e) => setRecipient(e.target.value as "guest" | "email")}>
                  <option value="guest">The guest (in their conversation)</option>
                  <option value="email">An email address (owner, cleaner, team)</option>
                </Select>
              </Field>
            ) : null}
            {kind === "message" && recipient === "email" ? (
              <Field label="Email address" htmlFor="email">
                <Input id="email" name="email" type="email" defaultValue={msg?.email ?? ""} required />
              </Field>
            ) : null}
          </div>
        </Card>

        {kind === "message" ? (
          <Card title="Content" description="Variables are filled in when the message is sent. If one has no value, the message fails visibly instead of going out broken.">
            <div className="flex flex-col gap-4">
              <Field label="Subject (email)" htmlFor="subject">
                <Input id="subject" name="subject" defaultValue={msg?.subject ?? ""} maxLength={300} />
              </Field>
              <div role="tablist" aria-label="Language" className="flex flex-wrap gap-1">
                {[["default", "Default"], ...LANGUAGES.filter(([code]) => variants[code] !== undefined)].map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    role="tab"
                    aria-selected={tab === code}
                    onClick={() => setTab(code)}
                    className={`rounded-full px-3 py-1.5 text-sm ${tab === code ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "border border-slate-300 dark:border-slate-700"}`}
                  >
                    {label}
                  </button>
                ))}
                <Select
                  aria-label="Add a language"
                  className="w-auto"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setVariants({ ...variants, [e.target.value]: variants[e.target.value] ?? "" });
                    setTab(e.target.value);
                  }}
                >
                  <option value="">+ Language</option>
                  {LANGUAGES.filter(([code]) => variants[code] === undefined).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="sr-only" htmlFor="body-editor">
                Message
              </label>
              <textarea
                id="body-editor"
                ref={bodyRef}
                rows={9}
                className={textarea}
                value={tab === "default" ? body : (variants[tab] ?? "")}
                onChange={(e) => (tab === "default" ? setBody(e.target.value) : setVariants({ ...variants, [tab]: e.target.value }))}
                required={tab === "default"}
              />
              <input type="hidden" name="body" value={body} />
              {Object.entries(variants).map(([code, text]) => (
                <input key={code} type="hidden" name={`variant_${code}`} value={text} />
              ))}
              <div className="flex flex-wrap gap-1.5">
                {VARIABLE_CATALOG.slice(0, 20).map((v) => (
                  <button key={v.name} type="button" onClick={() => insertVariable(v.name)} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200">
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        ) : (
          <Card title="Instructions for the agent" description="The agent reads the conversation, the booking and the listing, then drafts a message into the approval queue. Nothing is sent until someone approves it. Needs the AI key to be set up.">
            <textarea name="instructions" rows={5} className={textarea} defaultValue={initial.action.kind === "agent_draft" ? initial.action.instructions : ""} placeholder="e.g. Ask whether they need anything before arrival and offer late check-out if the next night is free." />
          </Card>
        )}
      </fieldset>

      <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
        <Card title="Review">
          <div className="flex flex-col gap-3 text-sm">
            <Field label="Sample reservation" htmlFor="sample">
              <Select id="sample" value={sample} onChange={(e) => setSample(e.target.value)}>
                {samples.length === 0 ? <option value="">No upcoming reservations</option> : null}
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="button" variant="secondary" disabled={checking} onClick={() => startCheck(async () => setPreview(await previewRule(fields(), sample || null)))}>
              {checking ? "Checking…" : "Preview"}
            </Button>
            {preview?.error ? <Alert tone="error">{preview.error}</Alert> : null}
            {preview && !preview.error ? (
              <>
                <p>
                  Applies to <strong>{preview.count}</strong> current or upcoming reservation{preview.count === 1 ? "" : "s"}.
                </p>
                {preview.next?.length ? (
                  <ul className="text-xs text-slate-600 dark:text-slate-300">
                    {preview.next.map((n) => (
                      <li key={n.reservation_id}>
                        {n.code}: {new Date(n.run_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preview.rendered ? (
                  <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
                    {preview.rendered.subject ? <p className="mb-2 font-medium">{preview.rendered.subject}</p> : null}
                    <p className="whitespace-pre-wrap">{preview.rendered.body}</p>
                    {preview.rendered.missing.length ? <p className="mt-2 text-amber-700">No value for: {preview.rendered.missing.join(", ")}</p> : null}
                  </div>
                ) : null}
                {preview.rendered && sample ? (
                  <Button type="button" variant="ghost" disabled={checking} onClick={() => startCheck(async () => setTestMsg(await sendTest(fields(), sample)))}>
                    Send a test to myself
                  </Button>
                ) : null}
                {testMsg?.error ? <Alert tone="error">{testMsg.error}</Alert> : null}
                {testMsg?.message ? <Alert tone="success">{testMsg.message}</Alert> : null}
              </>
            ) : null}
          </div>
        </Card>
        {canEdit ? (
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Saving…" : ruleId ? "Save changes" : "Create rule"}
          </Button>
        ) : null}
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state?.ok && state.message ? <Alert tone="success">{state.message}</Alert> : null}
      </div>
    </form>
  );
}
