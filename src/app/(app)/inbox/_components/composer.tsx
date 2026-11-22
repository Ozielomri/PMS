"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Alert, Badge, Button, Select, cx } from "@/components/ui";
import { pickVariant } from "@/lib/inbox/saved-replies";
import type { PreviewPart } from "@/lib/inbox/variables";

import { addNote, previewReply, rejectProposal, sendReply, suggestReply, type InboxActionResult, type PreviewResult } from "../actions";

export interface ComposerSavedReply {
  id: string;
  title: string;
  shortcut: string | null;
  body: string;
  language: string;
  variants: Record<string, string>;
}

interface Proposal {
  id: string;
  content: string;
  confidence: string;
  needsHuman: boolean;
  reasoning: string;
}

const textareaClass =
  "block w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

/**
 * INB-04 composer: reply by email (the originating channel) or add an internal note (INB-09).
 * Saved replies via "/" or the picker (INB-05), variables with a live resolved preview; sending is
 * blocked while a variable is unresolved (INB-06). "Suggest reply" asks the AI agent for a draft
 * (INB-11) that the user edits and sends.
 */
export function Composer({
  conversationId,
  reservationId,
  channelLabel,
  savedReplies,
  guestLanguage,
  variableNames,
  ai,
  initialProposal,
  members,
}: {
  conversationId: string;
  reservationId: string | null;
  channelLabel: string;
  savedReplies: ComposerSavedReply[];
  guestLanguage: string | null;
  variableNames: string[];
  ai: { enabled: boolean; reason?: string };
  initialProposal: Proposal | null;
  members: { id: string; name: string }[];
}) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [savedReplyId, setSavedReplyId] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(initialProposal);
  const [livePreview, setPreview] = useState<PreviewResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const [mentions, setMentions] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Clear after a successful send (the realtime refresh shows the new message).
  const [replyState, replyAction, replyPending] = useActionState<InboxActionResult, FormData>(async (prev, formData) => {
    const result = await sendReply(prev, formData);
    if (result?.ok) {
      setText("");
      setSavedReplyId("");
      setProposal(null);
      setPreview(null);
    }
    return result;
  }, null);
  const [noteState, noteAction, notePending] = useActionState<InboxActionResult, FormData>(async (prev, formData) => {
    const result = await addNote(prev, formData);
    if (result?.ok) {
      setText("");
      setMentions([]);
    }
    return result;
  }, null);

  // Live preview of the resolved text (debounced; resolved on the server).
  useEffect(() => {
    if (mode !== "reply" || !text.trim()) return;
    const t = setTimeout(async () => {
      const res = await previewReply(conversationId, text);
      if (!("error" in res)) setPreview(res);
    }, 350);
    return () => clearTimeout(t);
  }, [text, mode, conversationId]);
  const preview = mode === "reply" && text.trim() ? livePreview : null;

  // "/" shortcut: the word being typed after a slash.
  const slash = useMemo(() => /(?:^|\s)\/([a-z0-9_-]*)$/i.exec(text)?.[1]?.toLowerCase() ?? null, [text]);
  const slashMatches = useMemo(
    () =>
      slash === null
        ? []
        : savedReplies.filter((r) => (r.shortcut ?? "").startsWith(slash) || r.title.toLowerCase().includes(slash)).slice(0, 6),
    [slash, savedReplies],
  );

  function insertSavedReply(r: ComposerSavedReply, replaceSlash: boolean) {
    const body = pickVariant(r, guestLanguage);
    setText((prev) => (replaceSlash ? prev.replace(/\/[a-z0-9_-]*$/i, body) : prev ? `${prev}\n${body}` : body));
    setSavedReplyId(r.id);
    ref.current?.focus();
  }

  function insertVariable(name: string) {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) return setText((t) => t + token);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText(text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function suggest() {
    setAiError(null);
    startSuggest(async () => {
      const res = await suggestReply(conversationId);
      if (!res.ok) return setAiError(res.error);
      setProposal({ id: res.proposalId, content: res.content, confidence: res.confidence, needsHuman: res.needsHuman, reasoning: res.reasoning });
      setText(res.content);
      setMode("reply");
    });
  }

  async function dismissDraft() {
    if (!proposal) return;
    await rejectProposal(proposal.id);
    if (text === proposal.content) setText("");
    setProposal(null);
  }

  const unresolved = preview?.unresolved ?? [];
  const state = mode === "reply" ? replyState : noteState;
  const pending = mode === "reply" ? replyPending : notePending;
  const blocked = mode === "reply" && (unresolved.length > 0 || (preview !== null && preview.length > preview.limit));

  return (
    <div className="rounded-[22px] border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Message type" className="flex gap-1 rounded-full bg-slate-100 p-1 dark:bg-slate-800">
          {(["reply", "note"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cx("rounded-full px-3 py-1 text-sm", mode === m ? "bg-white font-medium shadow-sm dark:bg-slate-900" : "text-slate-600 dark:text-slate-300")}
            >
              {m === "reply" ? `Reply · ${channelLabel}` : "Internal note"}
            </button>
          ))}
        </div>
        {mode === "reply" ? (
          <>
            <Select aria-label="Insert saved reply" className="w-auto" value="" onChange={(e) => {
              const r = savedReplies.find((x) => x.id === e.target.value);
              if (r) insertSavedReply(r, false);
            }}>
              <option value="">Saved replies…</option>
              {savedReplies.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.shortcut ? ` (/${r.shortcut})` : ""}
                </option>
              ))}
            </Select>
            <Select aria-label="Insert variable" className="w-auto" value="" onChange={(e) => e.target.value && insertVariable(e.target.value)}>
              <option value="">Insert variable…</option>
              {variableNames.map((v) => (
                <option key={v} value={v}>
                  {`{{${v}}}`}
                </option>
              ))}
            </Select>
            <span className="ml-auto" title={ai.enabled ? "Draft a reply from the thread, the reservation and the listing" : ai.reason}>
              <Button type="button" variant="secondary" onClick={suggest} disabled={!ai.enabled || suggesting}>
                {suggesting ? "Drafting…" : "✦ Suggest reply"}
              </Button>
            </span>
          </>
        ) : null}
      </div>

      {mode === "reply" && !ai.enabled ? <p className="mb-2 text-xs text-slate-500">{ai.reason}</p> : null}
      {aiError ? (
        <div className="mb-2">
          <Alert tone="error">{aiError}</Alert>
        </div>
      ) : null}
      {mode === "reply" && proposal ? (
        <div className="mb-3 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm dark:border-brand-800 dark:bg-brand-800/30">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>AI draft</Badge>
            <Badge tone={proposal.confidence === "high" ? "green" : proposal.confidence === "low" ? "red" : "amber"}>{proposal.confidence} confidence</Badge>
            {proposal.needsHuman ? <Badge tone="amber">Needs your judgment</Badge> : null}
            <button type="button" onClick={dismissDraft} className="ml-auto text-xs text-slate-600 underline-offset-2 hover:underline dark:text-slate-300">
              Dismiss draft
            </button>
          </div>
          {proposal.reasoning ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{proposal.reasoning}</p> : null}
          <p className="mt-1 text-xs text-slate-500">Review and edit before sending. Nothing is sent until you press Send.</p>
        </div>
      ) : null}

      <form action={mode === "reply" ? replyAction : noteAction} className="space-y-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="reservationId" value={reservationId ?? ""} />
        {mode === "reply" ? (
          <>
            <input type="hidden" name="savedReplyId" value={savedReplyId} />
            <input type="hidden" name="proposalId" value={proposal?.id ?? ""} />
          </>
        ) : (
          mentions.map((m) => <input key={m} type="hidden" name="mentions" value={m} />)
        )}
        <div className="relative">
          <label htmlFor={`composer-${conversationId}`} className="sr-only">
            {mode === "reply" ? "Reply" : "Internal note"}
          </label>
          <textarea
            id={`composer-${conversationId}`}
            ref={ref}
            name="body"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={20000}
            placeholder={mode === "reply" ? "Write a reply… type / for saved replies" : "Note for the team (never sent to the guest)"}
            className={cx(textareaClass, mode === "note" && "border-dashed border-amber-400 bg-amber-50 dark:bg-amber-950/30")}
          />
          {mode === "reply" && slashMatches.length ? (
            <ul role="listbox" aria-label="Saved replies" className="absolute bottom-full left-2 z-10 mb-1 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {slashMatches.map((r) => (
                <li key={r.id}>
                  <button type="button" role="option" aria-selected={false} className="block w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => insertSavedReply(r, true)}>
                    <span className="font-medium">{r.title}</span>
                    {r.shortcut ? <span className="ml-2 text-xs text-slate-500">/{r.shortcut}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {mode === "note" && members.length ? (
          <fieldset className="flex flex-wrap items-center gap-2 text-xs">
            <legend className="sr-only">Mention</legend>
            <span className="text-slate-500">Mention:</span>
            {members.map((m) => (
              <label key={m.id} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={mentions.includes(m.id)} onChange={(e) => setMentions((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))} />
                {m.name}
              </label>
            ))}
          </fieldset>
        ) : null}

        {mode === "reply" && preview && text.trim() ? <Preview parts={preview.parts} /> : null}
        {mode === "reply" && unresolved.length ? (
          <Alert tone="error">
            Cannot send yet: {unresolved.map((v) => `{{${v}}}`).join(", ")} {unresolved.length === 1 ? "has" : "have"} no value for this guest or listing. Fill it in, or remove it.
          </Alert>
        ) : null}
        {mode === "reply" && preview?.warnings.length ? (
          <Alert>
            {preview.warnings.map((w) => (
              <span key={w} className="block">
                ⚠ {w}
              </span>
            ))}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant={mode === "reply" ? "primary" : "secondary"} disabled={pending || !text.trim() || blocked}>
            {pending ? "Sending…" : mode === "reply" ? "Send" : "Add note"}
          </Button>
          {mode === "reply" && preview ? (
            <span className={cx("text-xs tabular-nums", preview.length > preview.limit ? "text-red-700" : "text-slate-500")}>
              {preview.length.toLocaleString("en-US")} / {preview.limit.toLocaleString("en-US")} characters
            </span>
          ) : null}
          {state?.error ? <span className="text-sm text-red-700 dark:text-red-300" role="alert">{state.error}</span> : null}
          {state?.ok && state.message ? <span className="text-sm text-emerald-700 dark:text-emerald-300" role="status">{state.message}</span> : null}
        </div>
      </form>
    </div>
  );
}

function Preview({ parts }: { parts: PreviewPart[] }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Preview — what the guest receives</p>
      <p className="whitespace-pre-wrap break-words">
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <span key={i}>{p.text}</span>
          ) : p.kind === "value" ? (
            <mark key={i} title={`{{${p.name}}}`} className="rounded bg-emerald-100 px-0.5 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              {p.text}
            </mark>
          ) : (
            <mark key={i} className="rounded bg-red-100 px-0.5 text-red-800 dark:bg-red-950 dark:text-red-200">
              {p.text}
            </mark>
          ),
        )}
      </p>
    </div>
  );
}
