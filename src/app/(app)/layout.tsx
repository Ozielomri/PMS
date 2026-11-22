import Link from "next/link";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { ROLE_LABELS } from "@/lib/auth/permissions";

import { signOut } from "../(auth)/actions";
import { AccountSwitcher } from "./account-switcher";
import { NAV, SETTINGS_NAV } from "./nav";
import { NavLinks } from "./nav-links";


export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header>
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-5 sm:px-10">
          <Link href="/dashboard" className="font-display text-2xl font-semibold tracking-tight">
            PMS
          </Link>
          <Suspense fallback={<div className="h-5 w-64"><Skeleton lines={1} /></div>}>
            <TopBar />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-[1360px] px-4 pb-12 pt-4 sm:px-10">{children}</main>
    </div>
  );
}

async function TopBar() {
  const ctx = await requireAuthContext();
  return (
    <>
      <NavLinks
        items={[
          ...NAV.filter((item) => ctx.can(item.permission)).map(({ href, label }) => ({ href, label })),
          ...SETTINGS_NAV.filter((item) => ctx.can(item.permission))
            .slice(0, 1)
            .map(({ href }) => ({ href, label: "Settings", match: "/settings" })),
        ]}
      />
      <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
        {ctx.can("reservations.view") || ctx.can("properties.view") ? (
          <form action="/search" role="search">
            <label htmlFor="top-search" className="sr-only">
              Search
            </label>
            <input
              id="top-search"
              name="q"
              type="search"
              placeholder="Search…"
              className="w-44 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </form>
        ) : null}
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
