"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { HUMAN_ROLES } from "@/lib/auth/permissions";
import { siteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok?: boolean; error?: string; inviteUrl?: string } | null;

const PATH = "/settings/members";

function dbError(message: string | undefined): string {
  if (message?.startsWith("last_admin")) return "An account must keep at least one active admin.";
  if (message === "already_member") return "That person is already a member of this account.";
  if (message === "forbidden") return "You do not have permission to do that.";
  return "Something went wrong. Try again.";
}

export async function inviteMember(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const auth = await authorizeAction("account.manage_users");
  if (!auth.ok) return { error: auth.error };
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().email("Enter a valid email address"), role: z.enum(HUMAN_ROLES) })
    .safeParse({ email: formData.get("email"), role: formData.get("role") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_account_id: auth.ctx.active.accountId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  const created = (data as { invitation_id: string; token: string }[] | null)?.[0];
  if (error || !created) return { error: dbError(error?.message) };

  revalidatePath(PATH);
  // Email delivery arrives with the notifications centre (X-06); until then the admin shares the link.
  return { ok: true, inviteUrl: `${siteUrl()}/invite/${created.token}` };
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  const auth = await authorizeAction("account.manage_users");
  if (!auth.ok) return;
  const supabase = await createClient();
  await supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", String(formData.get("invitationId")))
    .eq("account_id", auth.ctx.active.accountId);
  revalidatePath(PATH);
}

export async function updateMember(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const auth = await authorizeAction("account.manage_users");
  if (!auth.ok) return { error: auth.error };
  const parsed = z
    .object({
      membershipId: z.guid(),
      role: z.enum(HUMAN_ROLES).optional(),
      status: z.enum(["active", "suspended", "removed"]).optional(),
    })
    .safeParse({
      membershipId: formData.get("membershipId"),
      role: formData.get("role") ?? undefined,
      status: formData.get("status") ?? undefined,
    });
  if (!parsed.success) return { error: "Invalid request." };
  const { membershipId, ...changes } = parsed.data;
  if (!changes.role && !changes.status) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .update(changes)
    .eq("id", membershipId)
    .eq("account_id", auth.ctx.active.accountId)
    .select("id");
  if (error) return { error: dbError(error.message) };
  if (!data?.length) return { error: "Member not found." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setListingScope(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const auth = await authorizeAction("account.manage_users");
  if (!auth.ok) return { error: auth.error };
  const split = (v: FormDataEntryValue | null) =>
    String(v ?? "")
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const parsed = z
    .object({
      membershipId: z.guid(),
      scope: z.enum(["all", "restricted"]),
      tags: z.array(z.string().max(200)).max(100),
      listingIds: z.array(z.guid("Listing IDs must be UUIDs")).max(500),
    })
    .safeParse({
      membershipId: formData.get("membershipId"),
      scope: formData.get("scope"),
      tags: split(formData.get("tags")),
      listingIds: split(formData.get("listingIds")),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request." };
  if (parsed.data.scope === "restricted" && parsed.data.tags.length + parsed.data.listingIds.length === 0) {
    return { error: "Add at least one tag or listing, or choose all listings." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_membership_listing_scope", {
    p_membership_id: parsed.data.membershipId,
    p_scope: parsed.data.scope,
    p_tags: parsed.data.tags,
    p_listing_ids: parsed.data.listingIds,
  });
  if (error) return { error: error.message.includes("admins_see_all_listings") ? "Admins always see all listings." : dbError(error.message) };
  revalidatePath(PATH);
  return { ok: true };
}
