/** CAL-09 / CAL-10 helpers for export tokens and feed URLs (pure, unit-tested). */
import { createHash } from "node:crypto";

import { generateToken } from "@/lib/crypto/secrets";

export const EXPORT_TOKEN_PREFIX = "pmsical_";
const TOKEN_PATTERN = /^pmsical_[A-Za-z0-9_-]{20,100}$/;

/** 256-bit random token; only its sha256 is stored for lookups. */
export function newExportToken(): string {
  return generateToken(EXPORT_TOKEN_PREFIX, 32);
}

export function isExportToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exportUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/$/, "")}/ical/${token}.ics`;
}

/** `/ical/<token>.ics` path segment → token, or null. */
export function tokenFromSegment(segment: string): string | null {
  const token = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
  return isExportToken(token) ? token : null;
}

/** Canonical form used for the per-listing duplicate check. */
export function feedUrlHash(url: URL): string {
  return sha256Hex(url.toString());
}

/**
 * What the editor shows for a feed: host and first path segment only. Feed URLs carry the other
 * channel's secret in the path or query (e.g. Airbnb `?s=…`, Vrbo `/icalendar/<secret>.ics`).
 */
export function feedUrlDisplay(url: URL): string {
  const first = url.pathname.split("/").filter(Boolean)[0];
  const more = url.pathname.split("/").filter(Boolean).length > 1 || url.search !== "";
  return `${url.host}${first ? `/${first.slice(0, 40)}` : ""}${more ? "/…" : ""}`.slice(0, 300);
}
