import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS, PERMISSIONS, ROLES, ROLE_PERMISSIONS, assignableRoles, can, isRole, roleHasPermission } from "@/lib/auth/permissions";

describe("permission matrix (X-01)", () => {
  it("gives admins every permission", () => {
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("only references defined permissions", () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toHaveProperty(p);
  });

  it.each([
    // [role, permission, expected] — straight from the requirements table
    ["manager", "properties.edit", true],
    ["manager", "properties.manage", false],
    ["manager", "reservations.cancel", true],
    ["manager", "automations.edit", true],
    ["manager", "automations.manage", false],
    ["manager", "account.manage_users", false],
    ["front_office", "properties.view", true],
    ["front_office", "properties.edit", false],
    ["front_office", "calendar.block", true],
    ["front_office", "calendar.edit", false],
    ["front_office", "reservations.create", true],
    ["front_office", "reservations.cancel", false],
    ["front_office", "inbox.manage", true],
    ["front_office", "automations.view", true],
    ["front_office", "automations.edit", false],
    ["front_office", "tasks.assign", true],
    ["front_office", "tasks.manage", false],
    ["supervisor", "calendar.view", true],
    ["supervisor", "calendar.block", false],
    ["supervisor", "reservations.view_money", false],
    ["supervisor", "inbox.reply", false],
    ["supervisor", "automations.view", false],
    ["supervisor", "tasks.manage", true],
    ["cleaner", "properties.view", false],
    ["cleaner", "properties.view_assigned", true],
    ["cleaner", "calendar.view", false],
    ["cleaner", "reservations.view", false],
    ["cleaner", "reservations.view_next_guest", true],
    ["cleaner", "inbox.view", false],
    ["cleaner", "tasks.view", false],
    ["cleaner", "tasks.update_own", true],
  ] as const)("%s → %s = %s", (role, permission, expected) => {
    expect(roleHasPermission(role, permission)).toBe(expected);
  });

  it("restricts account administration to admins", () => {
    for (const p of ["account.manage_users", "account.manage_settings", "audit.view", "webhooks.manage"] as const) {
      expect(ROLES.filter((r) => roleHasPermission(r, p))).toEqual(["admin"]);
    }
  });
});

describe("can()", () => {
  it("requires aal2 for admins (X-02)", () => {
    expect(can({ role: "admin" }, "account.view", "aal1")).toBe(false);
    expect(can({ role: "admin" }, "account.view", "aal2")).toBe(true);
  });

  it("does not require aal2 for other roles", () => {
    expect(can({ role: "cleaner" }, "tasks.view_own", "aal1")).toBe(true);
  });

  it("denies missing or inactive memberships", () => {
    expect(can(null, "account.view", "aal2")).toBe(false);
    expect(can({ role: "manager", status: "suspended" }, "account.view", "aal2")).toBe(false);
    expect(can({ role: "manager", status: "active" }, "account.view", "aal2")).toBe(true);
  });
});

describe("helpers", () => {
  it("isRole", () => {
    expect(isRole("front_office")).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it("only admins assign roles", () => {
    expect(assignableRoles("admin")).toEqual([...ROLES]);
    expect(assignableRoles("manager")).toEqual([]);
  });
});
