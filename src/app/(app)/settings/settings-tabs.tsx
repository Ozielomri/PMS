"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "@/components/ui";

export function SettingsTabs({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
      {items.map((i) => {
        const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              active ? "border-brand-600 font-medium text-slate-900 dark:text-white" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
