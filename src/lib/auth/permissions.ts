/**
 * X-01 role-based permissions.
 *
 * This matrix is the TypeScript mirror of the `role_permissions` table seeded in
 * supabase/migrations/20261121000300_accounts_roles_permissions.sql. The database is the
 * enforcement point (RLS calls private.has_permission); this copy drives the UI. A DB test
 * (tests/db/permissions.test.ts) fails if the two drift apart.
 *
 * Interpretation of the requirements table (docs/requirements.md, "Roles and permissions"):
 *   Full = Edit + create/archive/delete-like actions and module settings.
 *   Admins hold no permissions until their session is TOTP-verified (aal2), see X-02.
 */

export const ROLES = ["admin", "manager", "front_office", "supervisor", "cleaner", "agent"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles people can hold. `agent` is the AI agent (docs/plans/ai-agent.md): it acts through the
 * service role as actor type `agent`, never through a membership (the database refuses one).
 */
export const HUMAN_ROLES = ["admin", "manager", "front_office", "supervisor", "cleaner"] as const satisfies readonly Role[];
export type HumanRole = (typeof HUMAN_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  front_office: "Front office",
  supervisor: "Supervisor",
  cleaner: "Cleaner / field staff",
  agent: "AI agent",
};

export const PERMISSIONS = {
  "account.view": "See the account and its team",
  "account.manage_settings": "Change account settings",
  "account.manage_users": "Invite, remove and change roles of users",
  "audit.view": "Read the audit log",
  "events.view": "Read the domain event stream",
  "webhooks.manage": "Manage outbound webhooks and read their delivery log",

  "properties.view": "View all listings in scope",
  "properties.view_assigned": "View the units of one's own tasks",
  "properties.edit": "Edit existing listings",
  "properties.manage": "Create, duplicate and archive listings",

  "calendar.view": "View the calendar",
  "calendar.block": "Block and unblock dates",
  "calendar.edit": "Edit prices, rules and availability",
  "calendar.manage": "Manage calendar settings (iCal feeds)",

  "reservations.view": "View reservations",
  "reservations.view_money": "View reservation financials",
  "reservations.view_next_guest": "View the next guest summary (first name, guest count)",
  "reservations.create": "Create reservations and quotes",
  "reservations.edit": "Edit and alter reservations",
  "reservations.cancel": "Cancel reservations",
  "reservations.manage": "Financial adjustments, guest merges and other full-access actions",

  "inbox.view": "Read guest conversations",
  "inbox.reply": "Reply to guests",
  "inbox.manage": "Assign conversations and manage saved replies",

  "automations.view": "View automation rules and their runs",
  "automations.edit": "Create, edit, pause and resume automation rules",
  "automations.manage": "Delete automation rules",

  "tasks.view": "View all tasks in scope",
  "tasks.view_own": "View one's own tasks",
  "tasks.update_own": "Start, complete and comment on one's own tasks",
  "tasks.create": "Create tasks",
  "tasks.assign": "Assign and reassign tasks",
  "tasks.edit": "Edit tasks",
  "tasks.manage": "Cancel tasks and manage task templates",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const ADMIN: readonly Permission[] = ALL_PERMISSIONS;

const MANAGER: readonly Permission[] = [
  "account.view",
  "events.view",
  "properties.view",
  "properties.view_assigned",
  "properties.edit",
  "calendar.view",
  "calendar.block",
  "calendar.edit",
  "reservations.view",
  "reservations.view_money",
  "reservations.view_next_guest",
  "reservations.create",
  "reservations.edit",
  "reservations.cancel",
  "reservations.manage",
  "inbox.view",
  "inbox.reply",
  "inbox.manage",
  "automations.view",
  "automations.edit",
  "tasks.view",
  "tasks.view_own",
  "tasks.update_own",
  "tasks.create",
  "tasks.assign",
  "tasks.edit",
  "tasks.manage",
];

const FRONT_OFFICE: readonly Permission[] = [
  "account.view",
  "properties.view",
  "properties.view_assigned",
  "calendar.view",
  "calendar.block",
  "reservations.view",
  "reservations.view_money",
  "reservations.view_next_guest",
  "reservations.create",
  "reservations.edit",
  "inbox.view",
  "inbox.reply",
  "inbox.manage",
  "automations.view",
  "tasks.view",
  "tasks.view_own",
  "tasks.create",
  "tasks.assign",
];

// "Full on own team" for tasks: the team restriction arrives with task groups (TSK-07, step 8).
const SUPERVISOR: readonly Permission[] = [
  "account.view",
  "properties.view",
  "properties.view_assigned",
  "calendar.view",
  "reservations.view",
  "reservations.view_next_guest",
  "inbox.view",
  "tasks.view",
  "tasks.view_own",
  "tasks.update_own",
  "tasks.create",
  "tasks.assign",
  "tasks.edit",
  "tasks.manage",
];

const CLEANER: readonly Permission[] = [
  "account.view",
  "properties.view_assigned",
  "reservations.view_next_guest",
  "tasks.view_own",
  "tasks.update_own",
];

// The AI agent: reads what a guest-facing answer needs and replies in the inbox. No money, no
// edits, no cancellations (docs/plans/ai-agent.md, conservative defaults).
const AGENT: readonly Permission[] = [
  "account.view",
  "properties.view",
  "calendar.view",
  "reservations.view",
  "reservations.view_next_guest",
  "inbox.view",
  "inbox.reply",
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  admin: new Set(ADMIN),
  manager: new Set(MANAGER),
  front_office: new Set(FRONT_OFFICE),
  supervisor: new Set(SUPERVISOR),
  cleaner: new Set(CLEANER),
  agent: new Set(AGENT),
};

export type AuthenticatorAssuranceLevel = "aal1" | "aal2";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isHumanRole(value: unknown): value is HumanRole {
  return typeof value === "string" && (HUMAN_ROLES as readonly string[]).includes(value);
}

/** Static check: does this role grant this permission? */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Effective check, identical to private.has_permission in the database: an admin whose session
 * is not TOTP-verified holds no permissions.
 */
export function can(
  member: { role: Role; status?: string } | null | undefined,
  permission: Permission,
  aal: AuthenticatorAssuranceLevel,
): boolean {
  if (!member || (member.status !== undefined && member.status !== "active")) return false;
  if (member.role === "admin" && aal !== "aal2") return false;
  return roleHasPermission(member.role, permission);
}

/** Roles a given role may hand out when inviting. Only admins manage users in this phase; never `agent`. */
export function assignableRoles(role: Role): HumanRole[] {
  return role === "admin" ? [...HUMAN_ROLES] : [];
}
