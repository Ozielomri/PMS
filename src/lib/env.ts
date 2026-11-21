/**
 * Environment access. Values are read lazily so `next build` works without secrets, and each
 * accessor throws a clear error when a required variable is missing at runtime.
 */

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

/** Safe for the browser (NEXT_PUBLIC_*). Must be referenced literally for Next.js inlining. */
export function publicEnv() {
  return {
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabasePublishableKey: required(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  };
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Server-only secrets. */
export function serverEnv() {
  return {
    supabaseSecretKey: required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY),
    encryptionKey: required("PMS_ENCRYPTION_KEY", process.env.PMS_ENCRYPTION_KEY),
    cronSecret: required("CRON_SECRET", process.env.CRON_SECRET),
    /** Allow http:// and private hosts for webhook URLs. Never set in production. */
    webhooksAllowPrivateNetworks: process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORKS === "1",
  };
}
