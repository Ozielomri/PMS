"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "@/components/ui";

/** Pill navigation (design direction 3); highlights the section of the current page. */
export function NavLinks({ items }: { items: { href: string; label: string; match?: string }[] }) {
  const pathname = usePathname();
  const active = items
    .map((i) => ({ href: i.href, prefix: i.match ?? i.href }))
    .filter((i) => pathname === i.prefix || pathname.startsWith(`${i.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.href;
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-1 rounded-full bg-slate-100 p-1 dark:bg-slate-900">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.href === active ? "page" : undefined}
          className={cx(
            "rounded-full px-4 py-2 text-sm font-medium transition",
            item.href === active
              ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
