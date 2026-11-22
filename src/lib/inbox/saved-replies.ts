/** INB-05 saved replies: language variants. */

export interface SavedReplyBody {
  body: string;
  language: string;
  variants: Record<string, string>;
}

export const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/** The variant for the guest's language (exact, then base language), else the default body. */
export function pickVariant(reply: SavedReplyBody, language: string | null | undefined): string {
  if (!language) return reply.body;
  if (reply.variants[language]) return reply.variants[language];
  const base = language.split("-")[0];
  if (base === reply.language) return reply.body;
  if (reply.variants[base]) return reply.variants[base];
  const regional = Object.keys(reply.variants).find((k) => k.split("-")[0] === base);
  return regional ? reply.variants[regional] : reply.body;
}

export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["nl", "Dutch"],
  ["he", "Hebrew"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
];
