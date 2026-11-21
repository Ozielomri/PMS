/**
 * Returns a same-origin path to redirect to after sign-in, or the fallback. Rejects absolute
 * URLs, protocol-relative URLs ("//evil.com") and backslash tricks to prevent open redirects.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  // Control characters (incl. tab/newline, which browsers strip) are never valid here.
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const url = new URL(next, "http://localhost");
    if (url.origin !== "http://localhost") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
