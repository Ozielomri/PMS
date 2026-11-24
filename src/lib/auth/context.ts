import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { mfaRequirement, type AssuranceLevel, type MfaRequirement } from "@/lib/auth/mfa";
import { can, isRole, type Permission, type Role } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export const ACTIVE_ACCOUNT_COOKIE = "pms_account";

export interface MembershipSummary {
  id: string;
  accountId: string;
  accountName: string;
  role: Role;
}

export interface AuthContext {
  user: { id: string; email: string | null };
  aal: AssuranceLevel;
  mfa: MfaRequirement;
  memberships: MembershipSummary[];
  /** The account the user is working in (cookie, else first membership). */
  active: MembershipSummary | null;
  can(permission: Permission): boolean;
}

interface MembershipRow {
  id: string;
  role: string;
  account_id: string;
  accounts: { name: string } | null;
}

function toAal(value: unknown): AssuranceLevel | null {
  return value === "aal1" || value === "aal2" ? value : null;
}

/**
 * Data access layer for the signed-in user. Memoised per request. Returns null when signed out.
 * Uses getClaims(), which verifies the JWT, rather than trusting the session cookie.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return null;

  const [{ data: aalData }, { data: rows }, { data: mfaSwitch }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase
      .from("memberships")
      .select("id, role, account_id, accounts(name)")
      .eq("user_id", claims.sub)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .returns<MembershipRow[]>(),
    // X-02 platform switch; if it cannot be read, require MFA (fail closed).
    supabase.rpc("mfa_required"),
  ]);
  const mfaRequired = mfaSwitch !== false;

  const memberships: MembershipSummary[] = (rows ?? [])
    .filter((r) => isRole(r.role))
    .map((r) => ({ id: r.id, accountId: r.account_id, accountName: r.accounts?.name ?? "Account", role: r.role as Role }));

  const preferred = (await cookies()).get(ACTIVE_ACCOUNT_COOKIE)?.value;
  const active = memberships.find((m) => m.accountId === preferred) ?? memberships[0] ?? null;

  const aal: AssuranceLevel = toAal(claims.aal) ?? toAal(aalData?.currentLevel) ?? "aal1";
  const mfa = mfaRequirement({
    required: mfaRequired,
    isAdmin: memberships.some((m) => m.role === "admin"),
    currentLevel: aal,
    nextLevel: toAal(aalData?.nextLevel),
  });

  return {
    user: { id: claims.sub, email: (claims.email as string | undefined) ?? null },
    aal,
    mfa,
    memberships,
    active,
    can: (permission) => can(active, permission, aal, mfaRequired),
  };
});

export interface RequireOptions {
  permission?: Permission;
  /** For /onboarding: signed in, but no account yet. */
  allowNoAccount?: boolean;
  /** Path to come back to after MFA or sign-in. */
  returnTo?: string;
}

/** Redirects unless the user is signed in, has passed MFA, has an account and (optionally) a permission. */
export async function requireAuthContext(
  opts: RequireOptions = {},
): Promise<AuthContext & { active: MembershipSummary }> {
  const ctx = await getAuthContext();
  const next = opts.returnTo ? `?next=${encodeURIComponent(opts.returnTo)}` : "";
  if (!ctx) redirect(`/login${next}`);
  if (ctx.mfa !== "ok") redirect(`/mfa${next}`);
  if (!ctx.active) {
    if (opts.allowNoAccount) return ctx as AuthContext & { active: MembershipSummary };
    redirect("/onboarding");
  }
  if (opts.permission && !ctx.can(opts.permission)) redirect("/dashboard?denied=1");
  return ctx as AuthContext & { active: MembershipSummary };
}

/** For server actions: same checks, but returns an error instead of redirecting. */
export async function authorizeAction(
  permission: Permission,
): Promise<{ ok: true; ctx: AuthContext & { active: MembershipSummary } } | { ok: false; error: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "You are signed out. Sign in again." };
  if (ctx.mfa !== "ok") return { ok: false, error: "Verify two-factor authentication first." };
  if (!ctx.active) return { ok: false, error: "No account selected." };
  if (!ctx.can(permission)) return { ok: false, error: "You do not have permission to do that." };
  return { ok: true, ctx: ctx as AuthContext & { active: MembershipSummary } };
}

/** Remember which account the user works in. Server actions and route handlers only. */
export async function setActiveAccount(accountId: string): Promise<void> {
  (await cookies()).set(ACTIVE_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
