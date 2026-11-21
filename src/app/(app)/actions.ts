"use server";

import { redirect } from "next/navigation";

import { getAuthContext, setActiveAccount } from "@/lib/auth/context";

export async function switchAccount(accountId: string): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!ctx.memberships.some((m) => m.accountId === accountId)) return;
  await setActiveAccount(accountId);
  redirect("/dashboard");
}
