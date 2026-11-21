"use server";

import { redirect } from "next/navigation";

import { getAuthContext, setActiveAccount } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";

const ERRORS: Record<string, string> = {
  invitation_invalid: "This invitation is no longer valid.",
  invitation_expired: "This invitation has expired. Ask your admin for a new one.",
  invitation_email_mismatch: "This invitation was sent to a different email address.",
};

export async function acceptInvitation(_prev: { error?: string } | null, formData: FormData): Promise<{ error?: string } | null> {
  const token = String(formData.get("token") ?? "");
  const ctx = await getAuthContext();
  if (!ctx) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  const supabase = await createClient();
  const { data: membershipId, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error || !membershipId) return { error: ERRORS[error?.message ?? ""] ?? "Could not accept the invitation." };

  const { data: membership } = await supabase.from("memberships").select("account_id").eq("id", membershipId).single();
  if (membership?.account_id) await setActiveAccount(membership.account_id);
  redirect("/dashboard");
}
