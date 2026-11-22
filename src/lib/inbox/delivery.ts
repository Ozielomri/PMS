/**
 * INB-10 delivery status of an outbound message. Mirrors private.delivery_transition_allowed
 * (migration 20261125001200); tests/db/inbox-delivery.test.ts checks they match.
 *
 *   queued → sending → sent → delivered
 *                 ↘ queued (retry later)   sent → failed (bounce)
 *                 ↘ failed → queued (manual retry) | discarded
 */

export const DELIVERY_STATUSES = ["queued", "sending", "sent", "delivered", "failed", "discarded"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  queued: ["sending", "discarded"],
  // sending → sending: the worker's lease expired and another run claimed it again.
  sending: ["sending", "sent", "delivered", "queued", "failed"],
  sent: ["delivered", "failed"],
  delivered: [],
  failed: ["queued", "discarded"],
  discarded: [],
};

export function canDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isDeliveryFinal(status: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[status].length === 0;
}

const LABELS: Record<DeliveryStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  discarded: "Discarded",
};

export function deliveryLabel(status: DeliveryStatus): string {
  return LABELS[status];
}

export function deliveryTone(status: DeliveryStatus): "neutral" | "green" | "amber" | "red" {
  if (status === "delivered" || status === "sent") return "green";
  if (status === "failed") return "red";
  if (status === "queued" || status === "sending") return "amber";
  return "neutral";
}
