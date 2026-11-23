"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getAuthContext, setActiveAccount } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";

export async function createAccount(_prev: { error?: string } | null, formData: FormData): Promise<{ error?: string } | null> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login?next=/onboarding");

  const parsed = z
    .object({ name: z.string().trim().min(1, "Enter a company name").max(200), timezone: z.string().min(1) })
    .safeParse({ name: formData.get("name"), timezone: formData.get("timezone") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_account", { p_name: parsed.data.name, p_timezone: parsed.data.timezone });
  if (error || !data) return { error: "Could not create the account. Try again." };

  await setActiveAccount(String(data));
  // When the MFA switch is on, the dashboard sends new admins to enrol TOTP first (X-02).
  redirect("/dashboard");
}
