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

/** Public URL for email and invitation links: explicit setting, else Vercel's production domain. */
export function siteUrl(): string {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return (process.env.NEXT_PUBLIC_SITE_URL ?? (vercel ? `https://${vercel}` : "http://localhost:3000")).replace(/\/$/, "");
}

/**
 * Server-only secrets. Each one is read (and checked) only when used, so a deployment without,
 * say, SUPABASE_SECRET_KEY still serves every screen; only the workers that need it fail.
 */
export function serverEnv() {
  return {
    get supabaseSecretKey() {
      return required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY);
    },
    get encryptionKey() {
      return required("PMS_ENCRYPTION_KEY", process.env.PMS_ENCRYPTION_KEY);
    },
    get cronSecret() {
      return required("CRON_SECRET", process.env.CRON_SECRET);
    },
    /** Allow http:// and private hosts for webhook URLs. Never set in production. */
    get webhooksAllowPrivateNetworks() {
      return process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORKS === "1";
    },
  };
}
