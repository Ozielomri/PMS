/** First hop of x-forwarded-for (set by Vercel), else x-real-ip. */
export function clientIpFromHeaders(h: Pick<Headers, "get">): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || null;
}

export type ActorType = "automation" | "channel" | "api" | "system" | "agent";

/** Headers that tell the database who a service-role request acts for (see private.current_actor). */
export function actorHeaders(actor: { type: ActorType; id?: string | null }): Record<string, string> {
  const out: Record<string, string> = { "x-pms-actor-type": actor.type };
  if (actor.id) out["x-pms-actor-id"] = actor.id;
  return out;
}
