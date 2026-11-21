/**
 * X-02: TOTP 2FA, mandatory for Admins.
 *
 * Supabase Auth reports the session's current assurance level (aal1 = password or magic link,
 * aal2 = TOTP verified) and the next level the user could reach (aal2 when a verified factor
 * exists). This pure function decides what the app must do before letting the user in.
 */

export type AssuranceLevel = "aal1" | "aal2";

export type MfaRequirement =
  /** Session is good to go. */
  | "ok"
  /** User has a verified factor but this session has not used it yet. */
  | "verify"
  /** User must enrol a TOTP factor first (admins only). */
  | "enroll";

export function mfaRequirement(input: {
  /** Admin in the account being accessed (or in any account, to be safe). */
  isAdmin: boolean;
  currentLevel: AssuranceLevel | null | undefined;
  nextLevel: AssuranceLevel | null | undefined;
}): MfaRequirement {
  const current = input.currentLevel ?? "aal1";
  const next = input.nextLevel ?? current;

  if (current === "aal2") return "ok";
  // Anyone who has enrolled TOTP must use it, admin or not.
  if (next === "aal2") return "verify";
  return input.isAdmin ? "enroll" : "ok";
}

/** Normalises a user-typed TOTP code ("123 456" → "123456"); null if not 6 digits. */
export function normaliseTotpCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}
