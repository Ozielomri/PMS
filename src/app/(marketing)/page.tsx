import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "PMS — Property management for short-term rentals" },
  description:
    "One calendar, every booking, every guest message. A property management system for short-term rental managers with 5 to 50 units, with an AI agent that drafts your guest replies.",
};

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#ai", label: "AI agent" },
  { href: "#switch", label: "Switching" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const FEATURES: { title: string; body: string; icon: React.ReactNode }[] = [
  {
    title: "Multi-calendar",
    body: "Every listing, night by night. Drag to block or book, drag a stay to move it. Double bookings are refused by the database itself.",
    icon: <path d="M4 7h16M4 7v12h16V7M4 7V5h16v2M8 3v4M16 3v4M8 12h3M13 12h3M8 16h3" />,
  },
  {
    title: "Reservations",
    body: "Requests, approvals, alterations with price previews, cancellations with refund rules, payments and balances in one place.",
    icon: <path d="M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4" />,
  },
  {
    title: "Unified inbox",
    body: "Every guest conversation threaded by stay, with the booking next to it. Saved replies fill in names, dates and door codes for you.",
    icon: <path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5" />,
  },
  {
    title: "Multi-units",
    body: "Run a building of identical studios as one listing. Guests book the type; the calendar picks a free unit, and you can swap units with a drag.",
    icon: <path d="M4 20V8l8-4 8 4v12M9 20v-5h6v5M8 10h2M14 10h2" />,
  },
  {
    title: "Channels & iCal",
    body: "Direct Booking.com connection on the way; Airbnb, Vrbo and any other site stay in sync through iCal every 15 minutes.",
    icon: <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" />,
  },
  {
    title: "Team & audit trail",
    body: "Roles for managers, front office and cleaners. Every change is logged with who made it, and nothing is ever silently deleted.",
    icon: <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0-1-5.8M21 20a6 6 0 0 0-4-5.6" />,
  },
];

const FAQ: [string, string][] = [
  [
    "Who is it for?",
    "Short-term rental managers in the US running roughly 5 to 50 units: cabins, beach houses, city apartments and small buildings with identical units.",
  ],
  [
    "Does the AI reply to guests on its own?",
    "Not by default. The agent drafts replies from the conversation, the booking and your listing details; you edit and send. You decide later which simple answers it may send by itself.",
  ],
  [
    "Which channels are supported?",
    "A direct Booking.com connection is being built. Airbnb, Vrbo and other sites sync through iCal today, and direct bookings, inquiries and quotes are handled in the app.",
  ],
  [
    "Can I take payments?",
    "Not yet. You record payments, deposits and refunds by hand and always see the balance due per stay. Card payments come in a later phase.",
  ],
  [
    "Where is my data stored?",
    "In the United States. Every table is isolated per account, and guest data is handled under US privacy law (CCPA/CPRA).",
  ],
];

export default function MarketingHome() {
  return (
    <div className="min-h-screen overflow-x-clip">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4 sm:px-8">
          <Link href="/" className="font-display text-2xl font-semibold tracking-tight">
            PMS
          </Link>
          <nav aria-label="Site" className="hidden flex-1 gap-6 text-sm text-slate-600 md:flex dark:text-slate-300">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="hover:text-slate-900 dark:hover:text-white">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/login" className="rounded-full px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
              Sign in
            </Link>
            <Link href="/signup" className="rounded-full bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">
              Get early access
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-[1240px] items-center gap-12 px-4 pb-20 pt-14 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
          <div className="flex flex-col gap-6">
            <p className="w-fit rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              Early access · for managers with 5–50 units
            </p>
            <h1 className="font-display text-5xl leading-[1.05] sm:text-6xl">One calendar, every booking, every guest — in one calm place.</h1>
            <p className="max-w-xl text-lg text-slate-600 dark:text-slate-300">
              PMS runs your short-term rentals end to end: a multi-calendar that never double-books, reservations with clear money, and a guest inbox where an AI agent drafts the
              replies.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/signup" className="inline-flex min-h-12 items-center rounded-full bg-brand-600 px-6 text-base font-semibold text-white hover:bg-brand-700">
                Start free
              </Link>
              <a href="#features" className="inline-flex min-h-12 items-center rounded-full border border-slate-300 px-6 text-base font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                See how it works
              </a>
            </div>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600 dark:text-slate-300">
              {["No credit card", "US data hosting", "Cancel anytime"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check /> {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroPreview />
        </section>

        {/* Strip */}
        <section aria-label="At a glance" className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto grid max-w-[1240px] gap-6 px-4 py-8 text-sm sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
            {[
              ["No double bookings", "Overlaps are refused by the database, not just the screen."],
              ["Booking.com + iCal", "Direct connection in progress; Airbnb and Vrbo via iCal."],
              ["AI-drafted replies", "Grounded in your listing and the guest's booking."],
              ["Every change logged", "Who did what, when — for the whole team."],
            ].map(([t, b]) => (
              <div key={t}>
                <p className="font-display text-lg">{t}</p>
                <p className="mt-1 text-slate-600 dark:text-slate-300">{b}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-[1240px] scroll-mt-24 px-4 py-20 sm:px-8">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.08em] text-brand-700">Everything in one place</p>
            <h2 className="mt-2 font-display text-4xl sm:text-5xl">The whole operation, without the tab juggling.</h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="rounded-[22px] border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-800/30 dark:text-brand-100">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {f.icon}
                  </svg>
                </span>
                <h3 className="mt-4 font-display text-xl">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Deep dive: calendar */}
        <section className="mx-auto grid max-w-[1240px] items-center gap-12 px-4 pb-20 sm:px-8 lg:grid-cols-2">
          <CalendarPreview />
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.08em] text-brand-700">Calendar</p>
            <h2 className="mt-2 font-display text-4xl">See every night of every listing at a glance.</h2>
            <ul className="mt-6 flex flex-col gap-3 text-slate-700 dark:text-slate-200">
              {[
                "Drag across nights to book, quote, block or change the price.",
                "Drag a stay to another listing or dates — see the new price before it moves.",
                "Multi-units show how many units are free; bookings land on a real unit.",
                "Bulk-edit prices and minimum stays across listings with a preview.",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <Check /> <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* AI agent */}
        <section id="ai" className="scroll-mt-24 bg-[#3f2a1e] text-[#f6f1ea]">
          <div className="mx-auto grid max-w-[1240px] items-center gap-12 px-4 py-20 sm:px-8 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#fdba74]">AI agent</p>
              <h2 className="mt-2 font-display text-4xl sm:text-5xl">A teammate that drafts the reply before you open the message.</h2>
              <p className="mt-5 text-lg text-[#e7dccd]">
                The agent reads the conversation, the booking and your listing details, then writes a reply you can send as is or edit. It works with its own limited role — it
                can read and draft, never touch money or cancel a stay.
              </p>
              <ul className="mt-6 flex flex-col gap-3 text-[#f6f1ea]">
                {["Answers grounded in your real listing data", "You approve; nothing is sent on its own", "Every draft and decision is logged"].map((t) => (
                  <li key={t} className="flex gap-3">
                    <Check light /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <InboxPreview />
          </div>
        </section>

        {/* Switching */}
        <section id="switch" className="mx-auto max-w-[1240px] scroll-mt-24 px-4 py-20 sm:px-8">
          <div className="grid gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-brand-700">Coming from another PMS?</p>
              <h2 className="mt-2 font-display text-4xl">Switch without a blackout weekend.</h2>
              <p className="mt-4 text-slate-600 dark:text-slate-300">
                Keep your current tools running while you set up. Import each channel&apos;s calendar by iCal so nights stay blocked from day one, then move listings over at your own pace.
              </p>
            </div>
            <ol className="grid gap-4">
              {[
                ["1", "Add your listings", "Photos, rooms, amenities, fees and house rules — or a whole building as one multi-unit."],
                ["2", "Connect calendars", "Paste the iCal links from Airbnb, Vrbo and others. Booked nights block here within 15 minutes."],
                ["3", "Invite the team", "Managers, front office and cleaners each see exactly what their role needs."],
              ].map(([n, t, b]) => (
                <li key={n} className="flex gap-4 rounded-[22px] border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 font-display text-lg text-white">{n}</span>
                  <div>
                    <p className="font-display text-xl">{t}</p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{b}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex max-w-[1240px] flex-col items-center gap-6 px-4 py-20 text-center sm:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.08em] text-brand-700">Pricing</p>
            <h2 className="max-w-2xl font-display text-4xl sm:text-5xl">Free while we build it with you.</h2>
            <p className="max-w-xl text-slate-600 dark:text-slate-300">
              PMS is in early access. Use every feature at no cost while we shape it with our first managers. We&apos;ll announce pricing well before early access ends — no surprises.
            </p>
            <div className="mt-2 w-full max-w-md rounded-[22px] border border-slate-200 bg-slate-50 p-8 text-left dark:border-slate-800 dark:bg-slate-950">
              <p className="font-display text-2xl">Early access</p>
              <p className="mt-1 font-display text-5xl">
                $0<span className="text-lg text-slate-500"> / month</span>
              </p>
              <ul className="mt-6 flex flex-col gap-3 text-sm">
                {["All features, unlimited listings", "Calendar, reservations, inbox and AI drafts", "Team roles and audit log", "Direct help from the team building it"].map((t) => (
                  <li key={t} className="flex gap-3">
                    <Check /> {t}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className="mt-8 flex min-h-12 items-center justify-center rounded-full bg-brand-600 font-semibold text-white hover:bg-brand-700">
                Get early access
              </Link>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-3xl scroll-mt-24 px-4 py-20 sm:px-8">
          <h2 className="text-center font-display text-4xl">Questions</h2>
          <div className="mt-10 divide-y divide-slate-200 rounded-[22px] border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {q}
                  <span aria-hidden className="text-xl text-slate-400 transition group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="mx-auto max-w-[1240px] px-4 pb-20 sm:px-8">
          <div className="relative overflow-hidden rounded-[28px]">
            <Image src="/marketing/lake.jpg" alt="" fill sizes="(min-width: 1240px) 1240px, 100vw" className="object-cover" />
            <div className="relative bg-gradient-to-r from-[#3f2a1e]/90 to-[#3f2a1e]/40 px-8 py-16 text-[#f6f1ea] sm:px-14">
              <h2 className="max-w-xl font-display text-4xl sm:text-5xl">Spend the morning on your guests, not your tabs.</h2>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/signup" className="inline-flex min-h-12 items-center rounded-full bg-brand-600 px-6 font-semibold text-white hover:bg-brand-700">
                  Start free
                </Link>
                <Link href="/login" className="inline-flex min-h-12 items-center rounded-full border border-[#f6f1ea]/60 px-6 font-medium text-[#f6f1ea] hover:bg-white/10">
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:px-8">
          <span className="font-display text-lg text-slate-800 dark:text-slate-100">PMS</span>
          <nav aria-label="Footer" className="flex flex-wrap gap-5">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="hover:text-slate-800 dark:hover:text-white">
                {n.label}
              </a>
            ))}
            <Link href="/login" className="hover:text-slate-800 dark:hover:text-white">
              Sign in
            </Link>
          </nav>
          <span>Photos: Unsplash</span>
        </div>
      </footer>
    </div>
  );
}

function Check({ light }: { light?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={light ? "mt-0.5 shrink-0 text-[#fdba74]" : "mt-0.5 shrink-0 text-brand-600"}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

/** A stylised Today screen: arrival cards with real listing photos. Decorative. */
function HeroPreview() {
  const cards = [
    { img: "/marketing/beach.jpg", place: "Ocean Breeze Cottage · Destin", guest: "Emma Garcia", tag: "Paid", tagCls: "bg-emerald-100 text-emerald-800" },
    { img: "/marketing/cabin.jpg", place: "Smoky Ridge Cabin · Gatlinburg", guest: "Noah Lee", tag: "Vrbo", tagCls: "bg-indigo-100 text-indigo-800" },
  ];
  return (
    <div aria-hidden="true" className="relative">
      <div className="rounded-[28px] border border-slate-200 bg-slate-100 p-4 shadow-[0_30px_60px_-30px_rgba(63,42,30,0.45)] dark:border-slate-800 dark:bg-slate-900">
        <div className="rounded-[22px] bg-slate-50 p-5 dark:bg-slate-950">
          <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Sunday, November 22</p>
          <p className="mt-1 font-display text-2xl leading-tight">Four guests arrive today, six are settling in.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {cards.map((c) => (
              <div key={c.guest} className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                <div className="relative h-28">
                  <Image src={c.img} alt="" fill sizes="280px" className="object-cover" priority />
                </div>
                <div className="p-3">
                  <p className="truncate text-[11px] text-slate-500">{c.place}</p>
                  <p className="font-display text-base">{c.guest}</p>
                  <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${c.tagCls}`}>{c.tag}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-2xl bg-[#3f2a1e] p-4 text-[#f6f1ea]">
            <p className="text-xs text-[#d6c7b3]">Still to collect</p>
            <p className="font-display text-3xl">$56,145</p>
          </div>
        </div>
      </div>
      <div className="absolute -bottom-10 -right-3 hidden w-64 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl sm:block dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs font-semibold text-brand-700">AI draft ready</p>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">&ldquo;Hi Jack, there are two parking spots right by the door — both cars fit.&rdquo;</p>
      </div>
    </div>
  );
}

/** A stylised slice of the multi-calendar. Decorative. */
function CalendarPreview() {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows: { name: string; bars: { start: number; len: number; label: string; cls: string }[] }[] = [
    { name: "Ocean Breeze Cottage", bars: [{ start: 0, len: 3, label: "Emma Garcia", cls: "bg-emerald-600" }, { start: 4, len: 3, label: "Jack Lewis", cls: "bg-blue-700" }] },
    { name: "Magnolia House", bars: [{ start: 1, len: 5, label: "Olivia Moore", cls: "bg-blue-700" }] },
    { name: "Smoky Ridge Cabin", bars: [{ start: 0, len: 2, label: "Noah Lee", cls: "bg-indigo-600" }, { start: 3, len: 4, label: "Owen Wright", cls: "bg-rose-600" }] },
    { name: "Seaside · Studio 2", bars: [{ start: 2, len: 4, label: "Pending · Grace", cls: "bg-amber-600" }] },
  ];
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-[28px] border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="grid grid-cols-[140px_repeat(7,minmax(0,1fr))] text-center text-xs text-slate-500">
        <span />
        {days.map((d, i) => (
          <span key={d} className={i === 0 ? "rounded-md bg-brand-100 py-1 font-semibold text-brand-800" : "py-1"}>
            {d}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.name} className="relative mt-2 grid h-11 grid-cols-[140px_repeat(7,minmax(0,1fr))] items-center border-t border-slate-100 dark:border-slate-800">
          <span className="truncate pr-2 text-sm">{r.name}</span>
          {r.bars.map((b) => (
            <span
              key={b.label}
              className={`row-start-1 mx-0.5 flex h-7 items-center truncate rounded-full px-3 text-xs font-medium text-white ${b.cls}`}
              style={{ gridColumn: `${b.start + 2} / span ${b.len}` }}
            >
              {b.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A stylised inbox thread with an AI draft. Decorative. */
function InboxPreview() {
  return (
    <div aria-hidden="true" className="rounded-[28px] bg-[#f6f1ea] p-5 text-[#292019]">
      <div className="flex items-center gap-3 border-b border-[#e7dccd] pb-3">
        <div className="relative h-10 w-10 overflow-hidden rounded-full">
          <Image src="/marketing/villa.jpg" alt="" fill sizes="40px" className="object-cover" />
        </div>
        <div>
          <p className="font-semibold">Jack Lopez</p>
          <p className="text-xs text-[#6f665e]">Sunset Dunes Villa · arrives today</p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-3 text-sm">
        <p className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white p-3">Hello, is there parking on site, and how many cars fit? We are coming with two cars.</p>
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm border-2 border-dashed border-[#c2410c]/50 bg-[#fff4ec] p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#9a3412]">AI draft · edit before sending</p>
          Hi Jack, yes — there are two parking spots in the driveway, so both cars fit. Check-in is from 4pm; I&apos;ll send the door code this morning.
        </div>
        <div className="flex gap-2 self-end">
          <span className="rounded-full border border-[#d6c7b3] px-3 py-1.5 text-xs">Edit</span>
          <span className="rounded-full bg-[#c2410c] px-3 py-1.5 text-xs font-semibold text-white">Send</span>
        </div>
      </div>
    </div>
  );
}
