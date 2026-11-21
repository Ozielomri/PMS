import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

import { publicEnv } from "@/lib/env";
import { clientIpFromHeaders } from "@/lib/supabase/request-context";

/**
 * Server client acting as the signed-in user: every query runs under RLS with the user's JWT.
 * Forwards the browser's IP and request id so the audit log (X-03) can record them.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const { supabaseUrl, supabasePublishableKey } = publicEnv();

  const forwarded: Record<string, string> = {};
  const ip = clientIpFromHeaders(headerStore);
  if (ip) forwarded["x-pms-client-ip"] = ip;
  const requestId = headerStore.get("x-vercel-id") ?? headerStore.get("x-request-id");
  if (requestId) forwarded["x-request-id"] = requestId;

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: forwarded },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes
          // sessions, so this is safe to ignore.
        }
      },
    },
  });
}
