/**
 * Message channels. The `channel` column of conversations and messages takes these values; only
 * email has an adapter in step 6. Booking.com messages arrive in step 9 through the same tables.
 */

export const CHANNELS = ["email", "booking_com", "airbnb", "vrbo", "sms", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels the composer can send through today. */
export const SENDABLE_CHANNELS: readonly Channel[] = ["email"];

export const CHANNEL_LABELS: Record<Channel | "internal", string> = {
  email: "Email",
  booking_com: "Booking.com",
  airbnb: "Airbnb",
  vrbo: "Vrbo",
  sms: "SMS",
  whatsapp: "WhatsApp",
  internal: "Internal note",
};

/** Short glyph shown as the channel icon in lists. */
export const CHANNEL_ICONS: Record<Channel | "internal", string> = {
  email: "✉",
  booking_com: "B",
  airbnb: "A",
  vrbo: "V",
  sms: "✆",
  whatsapp: "W",
  internal: "✎",
};

const LIMITS: Record<Channel, number> = {
  email: 20000,
  booking_com: 4000,
  airbnb: 5000,
  vrbo: 5000,
  sms: 1600,
  whatsapp: 4096,
};

export function channelLimit(channel: Channel): number {
  return LIMITS[channel];
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

const OTA: Partial<Record<Channel, string>> = { booking_com: "Booking.com", airbnb: "Airbnb", vrbo: "Vrbo" };

/** Business rule: OTAs forbid contact details and external links; the composer warns before sending. */
export function channelWarnings(channel: Channel, text: string): string[] {
  const ota = OTA[channel];
  if (!ota) return [];
  const out: string[] = [];
  if (/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(text)) out.push(`${ota} does not allow email addresses in messages.`);
  if (/(\+?\d[\d\s().-]{8,}\d)/.test(text)) out.push(`${ota} does not allow phone numbers in messages.`);
  if (/(https?:\/\/|www\.)\S+/i.test(text)) out.push(`${ota} does not allow external links in messages.`);
  return out;
}
