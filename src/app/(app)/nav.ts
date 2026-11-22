import type { Permission } from "@/lib/auth/permissions";

/** Main navigation (pills) and the settings pages grouped under one "Settings" pill. */
export const NAV: { href: string; label: string; permission: Permission }[] = [
  { href: "/dashboard", label: "Today", permission: "account.view" },
  { href: "/calendar", label: "Calendar", permission: "calendar.view" },
  { href: "/reservations", label: "Reservations", permission: "reservations.view" },
  { href: "/properties", label: "Properties", permission: "properties.view" },
];

export const SETTINGS_NAV: { href: string; label: string; permission: Permission }[] = [
  { href: "/settings/members", label: "Team", permission: "account.manage_users" },
  { href: "/settings/reservations", label: "Booking settings", permission: "reservations.manage" },
  { href: "/settings/webhooks", label: "Webhooks", permission: "webhooks.manage" },
  { href: "/settings/audit", label: "Audit log", permission: "audit.view" },
];
