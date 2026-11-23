/** Paths reachable without a session. Everything else requires sign-in (see src/proxy.ts). */
const PUBLIC_PREFIXES = ["/login", "/signup", "/auth/", "/invite/", "/api/internal/", "/api/calendar/machine/", "/q/", "/ical/"];

/** Public pages matched exactly (the marketing home page). */
const PUBLIC_EXACT = ["/"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}
