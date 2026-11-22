"use client";

import { useActionState, useRef, useState, useTransition } from "react";

import { Alert, Badge, Button, Input, Select, cx } from "@/components/ui";
import { characterCount } from "@/lib/properties/constants";
import { PHOTO_ACCEPT, PHOTO_BUCKET, photoPath, validatePhotoFile } from "@/lib/properties/photos";
import { SECRET_MASK } from "@/lib/properties/secrets";
import { createClient } from "@/lib/supabase/client";
import { US_TIMEZONES } from "@/lib/timezones";

import { AutosaveForm } from "../_components/autosave";
import { changeTimezone, deletePhoto, recordPhotos, reorderPhotos, revealSecret, saveSecretValue, updatePhoto } from "./actions";

// ---------------------------------------------------------------------------
// Descriptions: textarea with a live counter against the channel limit (PRP-05)
// ---------------------------------------------------------------------------

export function CountedTextarea({ id, name, label, limit, defaultValue }: { id: string; name: string; label: string; limit: number; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const { count, over } = characterCount(value, limit);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
        <span className={cx("text-xs", over ? "font-medium text-red-600" : "text-slate-500")} aria-live="polite">
          {count.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
          {over ? " — over the channel limit" : ""}
        </span>
      </div>
      <textarea
        id={id}
        name={name}
        rows={name === "summary" ? 3 : 5}
        maxLength={10000}
        defaultValue={defaultValue}
        onChange={(e) => setValue(e.target.value)}
        className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timezone with confirmation when there are future bookings (business rule)
// ---------------------------------------------------------------------------

export function TimezoneForm({ listingId, current, disabled }: { listingId: string; current: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(changeTimezone.bind(null, listingId), null);
  const [tz, setTz] = useState(current);
  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <label htmlFor="tz" className="block text-sm font-medium">
            Timezone
          </label>
          <Select id="tz" name="timezone" value={tz} onChange={(e) => setTz(e.target.value)} disabled={disabled}>
            {US_TIMEZONES.some((t) => t.value === current) ? null : <option value={current}>{current}</option>}
            {US_TIMEZONES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || pending || tz === current}>
          Change timezone
        </Button>
      </div>
      {state?.needsConfirmation ? (
        <Alert tone="error">
          <p>{state.message}</p>
          {state.affected?.length ? (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {state.affected.map((a) => (
                <li key={a.holdId}>
                  {a.sourceType === "owner_stay" ? "Owner stay" : "Reservation"}: {a.checkIn} → {a.checkOut}
                </li>
              ))}
            </ul>
          ) : null}
          <input type="hidden" name="confirm" value="1" />
          <Button type="submit" variant="danger" className="mt-2" disabled={pending}>
            Confirm timezone change
          </Button>
        </Alert>
      ) : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Secret custom field: masked, reveal on demand, replace or remove (PRP-12)
// ---------------------------------------------------------------------------

export function SecretField({ listingId, fieldId, label, isSet, canEdit }: { listingId: string; fieldId: string; label: string; isSet: boolean; canEdit: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [isRevealing, startReveal] = useTransition();
  const [state, action, pending] = useActionState(saveSecretValue.bind(null, listingId, fieldId), null);

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{label}</span>
        <Badge tone="amber">Secret</Badge>
        <code className="text-sm" aria-label={revealed ? `${label} value` : `${label} hidden`}>
          {isSet ? (revealed ?? SECRET_MASK) : "Not set"}
        </code>
        {isSet && canEdit ? (
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            disabled={isRevealing}
            onClick={() =>
              revealed
                ? setRevealed(null)
                : startReveal(async () => {
                    const r = await revealSecret(listingId, fieldId);
                    setRevealError(r.error ?? null);
                    setRevealed(r.value ?? null);
                  })
            }
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="text-sm underline underline-offset-2" onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel" : isSet ? "Change" : "Set"}
          </button>
        ) : null}
      </div>
      {revealError ? <Alert tone="error">{revealError}</Alert> : null}
      {editing ? (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <Input name="secret" type="password" autoComplete="off" className="w-64" aria-label={`New ${label}`} maxLength={1000} />
          <Button type="submit" disabled={pending}>
            Save secret
          </Button>
          {isSet ? (
            <Button type="submit" name="clear" value="1" variant="ghost" disabled={pending}>
              Remove
            </Button>
          ) : null}
        </form>
      ) : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.ok && state.message ? <p className="text-xs text-emerald-700">{state.message}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photos: upload to Storage, drag to reorder, caption, room, delete (PRP-06)
// ---------------------------------------------------------------------------

export interface PhotoItem {
  id: string;
  url: string;
  caption: string | null;
  roomId: string | null;
}

async function imageSize(file: File): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null }; // e.g. HEIC, which browsers can't decode
  }
}

export function PhotoManager({
  listingId,
  accountId,
  photos,
  rooms,
  canEdit,
}: {
  listingId: string;
  accountId: string;
  photos: PhotoItem[];
  rooms: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [order, setOrder] = useState(photos.map((p) => p.id));
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dragged = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const ordered = order.map((id) => byId.get(id)).filter((p): p is PhotoItem => Boolean(p));

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const checked = [...files].map((f) => ({ file: f, check: validatePhotoFile(f) }));
    const invalid = checked.find((c) => !c.check.ok);
    if (invalid && !invalid.check.ok) {
      setMessage({ tone: "error", text: invalid.check.error });
      return;
    }
    setBusy(true);
    setMessage({ tone: "info", text: `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…` });
    const supabase = createClient();
    const uploaded = [];
    for (const { file, check } of checked) {
      if (!check.ok) continue;
      const path = photoPath(accountId, listingId, crypto.randomUUID(), check.extension);
      const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: check.contentType, upsert: false });
      if (error) {
        setBusy(false);
        setMessage({ tone: "error", text: `${file.name}: upload failed (${error.message}).` });
        return;
      }
      uploaded.push({ path, name: file.name, contentType: check.contentType, size: file.size, ...(await imageSize(file)) });
    }
    const result = await recordPhotos(listingId, uploaded);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
    setMessage(result?.error ? { tone: "error", text: result.error } : { tone: "success", text: result?.message ?? "Uploaded." });
  }

  async function move(from: string, to: string) {
    if (from === to) return;
    const next = order.filter((id) => id !== from);
    next.splice(next.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
    setOrder(next);
    const result = await reorderPhotos(listingId, next);
    if (result?.error) setMessage({ tone: "error", text: result.error });
  }

  function shift(id: string, delta: number) {
    const i = order.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    void move(id, order[j]);
  }

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={PHOTO_ACCEPT}
            aria-label="Upload photos"
            disabled={busy}
            onChange={(e) => void upload(e.target.files)}
            className="text-sm"
          />
          <span className="text-xs text-slate-500">JPEG, PNG or HEIC, up to 25 MB each. The first photo is the cover; drag to reorder.</span>
        </div>
      ) : null}
      {message ? <Alert tone={message.tone === "info" ? "info" : message.tone}>{message.text}</Alert> : null}
      {ordered.length === 0 ? <p className="text-sm text-slate-500">No photos yet. Listings need at least one photo to be activated.</p> : null}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((p, index) => (
          <li
            key={p.id}
            draggable={canEdit}
            onDragStart={() => (dragged.current = p.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragged.current) void move(dragged.current, p.id);
              dragged.current = null;
            }}
            className="space-y-2 rounded-2xl border border-slate-200 p-2 dark:border-slate-800"
          >
            <div className="relative">
              {/* Variants come from Supabase image transformations (lib/properties/photos.ts). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={p.caption ?? `Photo ${index + 1}`} className="aspect-[4/3] w-full rounded object-cover" loading="lazy" />
              {index === 0 ? (
                <span className="absolute left-2 top-2">
                  <Badge tone="green">Cover</Badge>
                </span>
              ) : null}
            </div>
            <AutosaveForm action={updatePhoto.bind(null, p.id, listingId)} disabled={!canEdit} label={`Photo ${index + 1} details`} className="space-y-2">
              <Input name="caption" defaultValue={p.caption ?? ""} placeholder="Caption" maxLength={500} aria-label={`Caption for photo ${index + 1}`} />
              <Select name="room_id" defaultValue={p.roomId ?? ""} aria-label={`Room for photo ${index + 1}`}>
                <option value="">No room</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </AutosaveForm>
            {canEdit ? (
              <div className="flex items-center justify-between text-sm">
                <span className="flex gap-2">
                  <button type="button" onClick={() => shift(p.id, -1)} disabled={index === 0} aria-label={`Move photo ${index + 1} earlier`}>
                    ←
                  </button>
                  <button type="button" onClick={() => shift(p.id, 1)} disabled={index === ordered.length - 1} aria-label={`Move photo ${index + 1} later`}>
                    →
                  </button>
                </span>
                <DeletePhotoButton photoId={p.id} listingId={listingId} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeletePhotoButton({ photoId, listingId }: { photoId: string; listingId: string }) {
  const [state, action, pending] = useActionState(deletePhoto, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm("Delete this photo?")) e.preventDefault();
      }}
    >
      <input type="hidden" name="photoId" value={photoId} />
      <input type="hidden" name="listingId" value={listingId} />
      <button type="submit" className="text-red-600 underline-offset-2 hover:underline" disabled={pending}>
        Delete
      </button>
      {state?.error ? <span className="ml-2 text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}
