import { Suspense } from "react";

import { requireAuthContext } from "@/lib/auth/context";

import { SETTINGS_NAV } from "../nav";
import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <Tabs />
      </Suspense>
      {children}
    </>
  );
}

async function Tabs() {
  const ctx = await requireAuthContext();
  const items = SETTINGS_NAV.filter((i) => ctx.can(i.permission)).map(({ href, label }) => ({ href, label }));
  return items.length > 1 ? <SettingsTabs items={items} /> : null;
}
