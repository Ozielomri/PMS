"use client";

import Link from "next/link";
import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cx } from "@/components/ui";

export type SaveState = { ok?: boolean; error?: string; savedAt?: string; message?: string; needsConfirmation?: boolean } | null;
type SaveAction = (prev: SaveState, formData: FormData) => Promise<SaveState>;

interface UnsavedRegistry {
  set(id: string, dirty: boolean): void;
  anyDirty(): boolean;
}

const UnsavedContext = createContext<UnsavedRegistry | null>(null);

/** Tracks unsaved forms on the page and warns before leaving it (tab switch or browser navigation). */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const registry = useMemo<UnsavedRegistry>(
    () => ({
      set(id, isDirty) {
        if (isDirty) dirty.current.add(id);
        else dirty.current.delete(id);
      },
      anyDirty: () => dirty.current.size > 0,
    }),
    [],
  );
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>;
}

export const UNSAVED_PROMPT = "You have unsaved changes on this tab. Leave without saving?";

/** A Link that asks before leaving while a form on the page has unsaved changes. */
export function GuardedLink({ onClick, ...props }: ComponentProps<typeof Link>) {
  const registry = useContext(UnsavedContext);
  return (
    <Link
      {...props}
      onClick={(e) => {
        if (registry?.anyDirty() && !window.confirm(UNSAVED_PROMPT)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
}

interface VersionedState {
  result: SaveState;
  /** Change counter of the last successful save. */
  savedVersion: number;
}

/**
 * Autosave per tab: every change is saved after a short pause (or on Enter). Shows Saving… /
 * Saved / errors, and registers itself as unsaved until the latest change is stored.
 */
export function AutosaveForm({
  action,
  children,
  className,
  delay = 800,
  label = "Changes",
  disabled = false,
}: {
  action: SaveAction;
  children: ReactNode;
  className?: string;
  delay?: number;
  label?: string;
  /** Read-only (the user may view but not edit). */
  disabled?: boolean;
}) {
  const id = useId();
  const registry = useContext(UnsavedContext);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changes = useRef(0);
  const [changeCount, setChangeCount] = useState(0);

  const [state, dispatch, pending] = useActionState<VersionedState, FormData>(
    async (prev, formData) => {
      const version = Number(formData.get("__version"));
      formData.delete("__version");
      const result = await action(prev.result, formData);
      return { result, savedVersion: result?.ok ? version : prev.savedVersion };
    },
    { result: null, savedVersion: 0 },
  );

  const dirty = changeCount !== state.savedVersion;
  useEffect(() => {
    registry?.set(id, dirty);
    return () => registry?.set(id, false);
  }, [registry, id, dirty]);

  function save() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    formData.set("__version", String(changes.current));
    startTransition(() => dispatch(formData));
  }

  function onChange() {
    if (disabled) return;
    changes.current += 1;
    setChangeCount(changes.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, delay);
  }

  const status = pending
    ? "Saving…"
    : state.result?.error
      ? null
      : dirty
        ? "Unsaved changes"
        : state.result?.savedAt
          ? "All changes saved"
          : null;

  return (
    <form
      ref={formRef}
      className={cx("space-y-4", className)}
      onChange={onChange}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      aria-label={label}
    >
      <fieldset disabled={disabled} className="space-y-4">
        {children}
      </fieldset>
      <div className="flex min-h-6 items-center gap-3 text-sm" aria-live="polite">
        {state.result?.error ? <span className="text-red-600 dark:text-red-400">{state.result.error}</span> : null}
        {status ? <span className={dirty && !pending ? "text-amber-600" : "text-slate-500"}>{status}</span> : null}
        {dirty && !pending ? (
          <button type="submit" className="text-sm underline underline-offset-2">
            Save now
          </button>
        ) : null}
      </div>
    </form>
  );
}
