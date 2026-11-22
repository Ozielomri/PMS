"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * INB-15: new messages, conversation changes and delivery updates arrive through Supabase Realtime
 * (RLS applies, so a user only hears about conversations they may read) and refresh the server-
 * rendered inbox. Bursts are coalesced into one refresh.
 */
export function InboxLive({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    const filter = `account_id=eq.${accountId}`;
    const channel = supabase
      .channel(`inbox:${accountId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter }, refresh)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "message_deliveries", filter }, refresh)
      .subscribe((s) => setStatus(s === "SUBSCRIBED" ? "live" : s === "CLOSED" || s === "CHANNEL_ERROR" ? "offline" : "connecting"));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [accountId, router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" title="New messages appear without reloading">
      <span aria-hidden className={status === "live" ? "text-emerald-600" : status === "offline" ? "text-red-600" : "text-amber-600"}>
        ●
      </span>
      {status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting"}
    </span>
  );
}
