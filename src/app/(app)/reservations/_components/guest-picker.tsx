"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui";

import { searchGuests, type GuestHit } from "../actions";

export function guestLabel(g: GuestHit): string {
  return [[g.first_name, g.last_name].filter(Boolean).join(" "), g.email ?? g.phone].filter(Boolean).join(" · ");
}

/** Type-ahead over existing guests; calls onPick with the chosen guest (or null to clear). */
export function GuestPicker({ onPick, placeholder = "Search guests by name, email or phone", exclude }: { onPick: (g: GuestHit | null) => void; placeholder?: string; exclude?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GuestHit[]>([]);
  const [picked, setPicked] = useState<GuestHit | null>(null);

  useEffect(() => {
    if (picked || q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      const found = await searchGuests(q);
      if (live) setHits(found.filter((g) => g.id !== exclude));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, picked, exclude]);

  if (picked) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
        <span>{guestLabel(picked)}</span>
        <button
          type="button"
          className="text-slate-500 underline"
          onClick={() => {
            setPicked(null);
            setQ("");
            setHits([]);
            onPick(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Search guests" type="search" />
      {hits.length && q.trim().length >= 2 ? (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900" role="listbox">
          {hits.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="block w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => {
                  setPicked(g);
                  onPick(g);
                }}
              >
                {guestLabel(g)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
