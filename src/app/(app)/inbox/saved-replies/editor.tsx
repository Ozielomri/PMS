"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/inbox/saved-replies";
import type { PreviewPart } from "@/lib/inbox/variables";

import { previewSavedReply, saveSavedReply, type InboxActionResult } from "../actions";

const area =
  "block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

export interface EditorReply {
  id: string;
  title: string;
  shortcut: string | null;
  body: string;
  language: string;
  variants: Record<string, string>;
}

/** INB-05 editor: variables, language variants and a preview against a sample reservation. */
export function SavedReplyEditor({
  reply,
  variableNames,
  samples,
}: {
  reply: EditorReply | null;
  variableNames: string[];
  samples: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<InboxActionResult, FormData>(saveSavedReply, null);
  const [body, setBody] = useState(reply?.body ?? "");
  const [variants, setVariants] = useState<{ language: string; body: string }[]>(Object.entries(reply?.variants ?? {}).map(([language, b]) => ({ language, body: b })));
  const [sample, setSample] = useState(samples[0]?.id ?? "");
  const [preview, setPreview] = useState<{ parts: PreviewPart[]; unresolved: string[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!sample || !body.trim()) return;
    const t = setTimeout(async () => {
      const res = await previewSavedReply(sample, body);
      setPreview("error" in res ? null : res);
    }, 350);
    return () => clearTimeout(t);
  }, [sample, body]);

  function insert(name: string) {
    const el = ref.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
  }

  return (
    <form action={action} className="space-y-4">
      {reply ? <input type="hidden" name="id" value={reply.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_160px]">
        <Field label="Title" htmlFor="sr-title">
          <Input id="sr-title" name="title" defaultValue={reply?.title ?? ""} required maxLength={100} />
        </Field>
        <Field label="Shortcut" htmlFor="sr-shortcut" hint="Type /shortcut in the composer">
          <Input id="sr-shortcut" name="shortcut" defaultValue={reply?.shortcut ?? ""} maxLength={30} placeholder="checkin" />
        </Field>
        <Field label="Language" htmlFor="sr-language">
          <Select id="sr-language" name="language" defaultValue={reply?.language ?? "en"}>
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="space-y-1">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label htmlFor="sr-body" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Message
          </label>
          <Select aria-label="Insert variable" className="w-auto" value="" onChange={(e) => e.target.value && insert(e.target.value)}>
            <option value="">Insert variable…</option>
            {variableNames.map((v) => (
              <option key={v} value={v}>{`{{${v}}}`}</option>
            ))}
          </Select>
        </div>
        <textarea id="sr-body" ref={ref} name="body" rows={6} required maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} className={area} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">Language variants</legend>
        <p className="text-xs text-slate-500">Sent instead of the main text when the guest&apos;s language matches.</p>
        {variants.map((v, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
            <Select name="variantLanguage" aria-label="Variant language" value={v.language} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)))}>
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
            <textarea name="variantBody" aria-label="Variant text" rows={3} value={v.body} maxLength={10000} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} className={area} />
            <Button type="button" variant="ghost" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setVariants([...variants, { language: "es", body: "" }])}>
          Add language
        </Button>
      </fieldset>

      {samples.length ? (
        <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Preview with</span>
            <Select aria-label="Sample reservation" className="w-auto" value={sample} onChange={(e) => setSample(e.target.value)}>
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {preview && body.trim() ? (
            <>
              <p className="whitespace-pre-wrap text-sm">
                {preview.parts.map((p, i) =>
                  p.kind === "text" ? (
                    <span key={i}>{p.text}</span>
                  ) : (
                    <mark key={i} className={p.kind === "value" ? "rounded bg-emerald-100 px-0.5 dark:bg-emerald-950" : "rounded bg-red-100 px-0.5 text-red-800 dark:bg-red-950 dark:text-red-200"}>
                      {p.text}
                    </mark>
                  ),
                )}
              </p>
              {preview.unresolved.length ? (
                <p className="text-xs text-red-700 dark:text-red-300">No value for this reservation: {preview.unresolved.map((v) => `{{${v}}}`).join(", ")}. Sending would be blocked.</p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-slate-500">Write the message to see it with this reservation&apos;s values.</p>
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save reply"}
        </Button>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}
      </div>
    </form>
  );
}
