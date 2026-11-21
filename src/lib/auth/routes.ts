/** Paths reachable without a session. Everything else requires sign-in (see src/proxy.ts). */
const PUBLIC_PREFIXES = ["/login", "/signup", "/auth/", "/invite/", "/api/internal/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}
