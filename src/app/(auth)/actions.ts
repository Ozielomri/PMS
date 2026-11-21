"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { safeNextPath } from "@/lib/auth/redirect";
import { siteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type FormState = { error?: string; message?: string } | null;

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const PASSWORD_MIN_LENGTH = 12;

function confirmUrl(next: string) {
  return `${siteUrl()}/auth/confirm?next=${encodeURIComponent(next)}`;
}

export async function signInWithPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ email, password: z.string().min(1, "Enter your password") })
    .safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: error.code === "email_not_confirmed" ? "Confirm your email address first." : "Invalid email or password." };
  }
  // The destination enforces MFA (admins must verify TOTP before seeing anything).
  redirect(safeNextPath(String(formData.get("next") ?? "")));
}

export async function sendMagicLink(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = email.safeParse(formData.get("email"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const next = safeNextPath(String(formData.get("next") ?? ""));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: confirmUrl(next), shouldCreateUser: true },
  });
  if (error) {
    return { error: error.status === 429 ? "Too many requests. Wait a minute and try again." : "Could not send the link. Try again." };
  }
  // Same message whether or not the address has an account (no user enumeration).
  return { message: "Check your email for a sign-in link." };
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({
      fullName: z.string().trim().min(1, "Enter your name").max(200),
      email,
      password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`).max(200),
    })
    .safeParse({ fullName: formData.get("fullName"), email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const next = safeNextPath(String(formData.get("next") ?? ""), "/onboarding");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.fullName }, emailRedirectTo: confirmUrl(next) },
  });
  if (error) {
    if (error.code === "weak_password") return { error: "That password is too weak or has appeared in a data breach." };
    return { error: error.status === 429 ? "Too many requests. Wait a minute and try again." : "Could not create the account. Try again." };
  }
  if (data.session) redirect(next);
  return { message: "Check your email to confirm your address, then continue from the link." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
