"use client";

import { useEffect, useState } from "react";

import { Badge, formatDateTime } from "@/components/ui";
import type { DomainEvent } from "@/lib/events/types";
import { createClient } from "@/lib/supabase/client";

interface InsertedRow {
  id: string;
  type: string;
  account_id: string;
  occurred_at: string;
  seq: number;
  txid: number;
  entity_type: string;
  entity_id: string;
  actor_type: DomainEvent["actor"]["type"];
  actor_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * Subscribes to INSERTs on public.domain_events via Supabase Realtime. Realtime applies the
 * table's RLS, so a user only receives events they may read (events.view).
 */
export function LiveEvents({ accountId, initial }: { accountId: string; initial: DomainEvent[] }) {
  const [events, setEvents] = useState(initial);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`events:${accountId}`)
      .on<InsertedRow>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "domain_events", filter: `account_id=eq.${accountId}` },
        ({ new: r }) => {
          const event: DomainEvent = {
            id: r.id,
            type: r.type,
            account_id: r.account_id,
            occurred_at: r.occurred_at,
            sequence: r.seq,
            transaction_id: String(r.txid),
            entity: { type: r.entity_type, id: r.entity_id },
            actor: { type: r.actor_type, id: r.actor_id },
            data: r.payload,
          };
          setEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)].slice(0, 50));
        },
      )
      .subscribe((s) => setStatus(s === "SUBSCRIBED" ? "live" : s === "CLOSED" || s === "CHANNEL_ERROR" ? "offline" : "connecting"));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [accountId]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        <span className={status === "live" ? "text-emerald-600" : undefined}>●</span> {status}
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No events yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2">
                <Badge>{e.type}</Badge>
                <span className="text-xs text-slate-500">by {e.actor.type}</span>
              </span>
              <time className="text-xs text-slate-500" dateTime={e.occurred_at}>
                {formatDateTime(e.occurred_at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
