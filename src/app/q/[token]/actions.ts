"use server";

import { z } from "zod";

import { reservationErrorMessage } from "@/lib/reservations/errors";
import { createClient } from "@/lib/supabase/server";

/** RES-05: the guest books one option from the public link. The token is the only key. */
export async function acceptQuote(token: string, optionId: string): Promise<{ code?: string; error?: string }> {
  if (!/^[0-9a-f]{48}$/.test(token) || !z.guid().safeParse(optionId).success) return { error: "This link is not valid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_quote", { p_token: token, p_option_id: optionId });
  if (error) {
    if (error.message.startsWith("calendar_conflict")) return { error: "Sorry, those dates were just booked. Please contact us for alternatives." };
    return { error: reservationErrorMessage(error.message) };
  }
  return { code: (data as { reservation_code: string }).reservation_code };
}
