"use client";

import { useTransition } from "react";

import { switchAccount } from "./actions";

export function AccountSwitcher({ accounts, activeAccountId }: { accounts: { id: string; name: string }[]; activeAccountId: string }) {
  const [pending, startTransition] = useTransition();
  if (accounts.length < 2) {
    return <span className="font-medium">{accounts.find((a) => a.id === activeAccountId)?.name}</span>;
  }
  return (
    <select
      aria-label="Account"
      className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      value={activeAccountId}
      disabled={pending}
      onChange={(e) => startTransition(() => switchAccount(e.target.value))}
    >
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
