import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";
import { actorHeaders, type ActorType } from "@/lib/supabase/request-context";

/**
 * Service-role client for workers only (bypasses RLS). Always states which non-user actor it
 * acts for, so audit entries and events are attributed correctly. Never use it to serve a
 * user's request — use lib/supabase/server.ts so RLS applies.
 */
export function createAdminClient(actor: { type: ActorType; id?: string | null }) {
  const { supabaseUrl } = publicEnv();
  const { supabaseSecretKey } = serverEnv();
  return createSupabaseClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: actorHeaders(actor) },
  });
}
