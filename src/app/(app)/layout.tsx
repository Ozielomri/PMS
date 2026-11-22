import Link from "next/link";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { ROLE_LABELS, type Permission } from "@/lib/auth/permissions";

import { signOut } from "../(auth)/actions";
import { AccountSwitcher } from "./account-switcher";

const NAV: { href: string; label: string; permission: Permission }[] = [
  { href: "/dashboard", label: "Dashboard", permission: "account.view" },
  { href: "/properties", label: "Properties", permission: "properties.view" },
  { href: "/settings/members", label: "Team", permission: "account.manage_users" },
  { href: "/settings/webhooks", label: "Webhooks", permission: "webhooks.manage" },
  { href: "/settings/audit", label: "Audit log", permission: "audit.view" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            PMS
          </Link>
          <Suspense fallback={<div className="h-5 w-64"><Skeleton lines={1} /></div>}>
            <TopBar />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

async function TopBar() {
  const ctx = await requireAuthContext();
  return (
    <>
      <nav aria-label="Main" className="flex flex-1 flex-wrap gap-4 text-sm">
        {NAV.filter((item) => ctx.can(item.permission)).map((item) => (
          <Link key={item.href} href={item.href} className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center gap-3 text-sm">
        <AccountSwitcher
          activeAccountId={ctx.active.accountId}
          accounts={ctx.memberships.map((m) => ({ id: m.accountId, name: m.accountName }))}
        />
        <span className="hidden text-slate-500 sm:inline" title={ctx.user.email ?? undefined}>
          {ROLE_LABELS[ctx.active.role]}
        </span>
        <form action={signOut}>
          <button type="submit" className="text-slate-600 underline-offset-2 hover:underline dark:text-slate-300">
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}
