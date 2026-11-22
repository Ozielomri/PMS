"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/properties/money";
import { POLICY_SUMMARIES } from "@/lib/reservations/refunds";
import { createClient } from "@/lib/supabase/client";

import { cancelReservation, fileDownloadUrl, mergeGuests, registerFile, type CancelPreview, type GuestHit } from "../actions";
import { GuestPicker, guestLabel } from "../_components/guest-picker";

/** RES-07: choose who cancels, preview the refund, then confirm. */
export function CancelPanel({ reservationId, policy, canCustom, currency }: { reservationId: string; policy: string; canCustom: boolean; currency: string }) {
  const [state, action, pending] = useActionState(cancelReservation, null);
  const [open, setOpen] = useState(false);
  const intent = useRef<HTMLInputElement>(null);
  const preview = state?.ok && state.data && !state.message ? (state.data as CancelPreview) : null;

  if (!open) {
    return (
      <Button variant="danger" type="button" onClick={() => setOpen(true)}>
        Cancel reservation…
      </Button>
    );
  }
  return (
    <form action={action} className="space-y-3 rounded-md border border-red-200 p-4 dark:border-red-900">
      <input type="hidden" name="reservationId" value={reservationId} />
      <input type="hidden" name="intent" value="preview" ref={intent} />
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Policy: <strong>{policy}</strong> — {POLICY_SUMMARIES[policy] ?? ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Canceled by" htmlFor="canceledBy">
          <Select id="canceledBy" name="canceledBy" defaultValue="guest" onChange={() => intent.current && (intent.current.value = "preview")}>
            <option value="guest">Guest (policy applies)</option>
            <option value="host">Host (full refund)</option>
          </Select>
        </Field>
        {canCustom ? (
          <Field label="Custom refund %" htmlFor="refundPercent" hint="Leave empty to follow the policy.">
            <Input id="refundPercent" name="refundPercent" type="number" min={0} max={100} />
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Field label="Reason" htmlFor="cancel-reason">
            <Input id="cancel-reason" name="reason" maxLength={1000} />
          </Field>
        </div>
      </div>
      {preview ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800">
          <dt>Refundable</dt>
          <dd className="text-right">{preview.refund_percent} %</dd>
          <dt>Kept (new total)</dt>
          <dd className="text-right tabular-nums">{formatMoney(preview.kept_cents, currency)}</dd>
          <dt>Paid so far</dt>
          <dd className="text-right tabular-nums">{formatMoney(preview.paid_cents, currency)}</dd>
          <dt className="font-medium">Refund to the guest</dt>
          <dd className="text-right font-medium tabular-nums">{formatMoney(preview.refund_due_cents, currency)}</dd>
          {preview.balance_due_cents > 0 ? (
            <>
              <dt>Still owed by the guest</dt>
              <dd className="text-right tabular-nums">{formatMoney(preview.balance_due_cents, currency)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.message ? <Alert tone="success">{state.message}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={pending} onClick={() => intent.current && (intent.current.value = "preview")}>
          Preview refund
        </Button>
        {preview ? (
          <Button type="submit" variant="danger" disabled={pending} onClick={() => intent.current && (intent.current.value = "confirm")}>
            {pending ? "Canceling…" : "Confirm cancellation"}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** RES-11 merge a duplicate guest into this one. */
export function MergeGuest({ keepId, reservationId }: { keepId: string; reservationId: string }) {
  const [state, action, pending] = useActionState(mergeGuests, null);
  const [other, setOther] = useState<GuestHit | null>(null);
  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={(e) => {
        if (!other || !window.confirm(`Merge ${guestLabel(other)} into this guest? Their reservations move here. This cannot be undone.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="keepId" value={keepId} />
      <input type="hidden" name="mergeId" value={other?.id ?? ""} />
      <input type="hidden" name="reservationId" value={reservationId} />
      <GuestPicker onPick={setOther} exclude={keepId} placeholder="Find the duplicate guest" />
      <Button type="submit" variant="secondary" disabled={!other || pending}>
        {pending ? "Merging…" : "Merge into this guest"}
      </Button>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.message ? <Alert tone="success">{state.message}</Alert> : null}
    </form>
  );
}

/** Upload straight to the private bucket (RLS checks the path), then record the file. */
export function FileUpload({ reservationId, accountId }: { reservationId: string; accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="sr-only">Attach a file</span>
        <input
          type="file"
          disabled={busy}
          className="text-sm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 25 * 1024 * 1024) return setMsg({ tone: "error", text: "Files are 25 MB at most." });
            setBusy(true);
            setMsg(null);
            const safe = file.name.replace(/[^\w.\- ]+/g, "_").slice(-120);
            const path = `${accountId}/${reservationId}/${crypto.randomUUID()}-${safe}`;
            const { error } = await createClient().storage.from("reservation-files").upload(path, file, { contentType: file.type || "application/octet-stream" });
            if (error) {
              setBusy(false);
              return setMsg({ tone: "error", text: "Upload failed. Check your permission and try again." });
            }
            const result = await registerFile({ reservationId, path, name: file.name.slice(0, 255), contentType: file.type, size: file.size });
            setBusy(false);
            setMsg(result?.error ? { tone: "error", text: result.error } : { tone: "success", text: "File attached." });
            if (!result?.error) router.refresh();
          }}
        />
      </label>
      {busy ? <p className="text-sm text-slate-500">Uploading…</p> : null}
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}

export function DownloadFile({ fileId, name }: { fileId: string; name: string }) {
  return (
    <button
      type="button"
      className="text-left underline underline-offset-2"
      onClick={async () => {
        const r = await fileDownloadUrl(fileId);
        if (r.url) window.location.href = r.url;
        else window.alert(r.error ?? "Could not download.");
      }}
    >
      {name}
    </button>
  );
}
