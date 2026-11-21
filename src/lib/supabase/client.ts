"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser client (user session from cookies, RLS enforced). Used for MFA and Realtime. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
