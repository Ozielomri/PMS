import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Card, PageHeader, Skeleton } from "@/components/ui";
import { requireAuthContext } from "@/lib/auth/context";
import { CUSTOM_FIELD_TYPE_LABELS } from "@/lib/properties/constants";
import type { CustomFieldRow } from "@/lib/properties/queries";
import { createClient } from "@/lib/supabase/server";

import { setCustomFieldArchived } from "../actions";
import { CustomFieldForm } from "./custom-field-form";

export const metadata: Metadata = { title: "Custom fields" };

export default function CustomFieldsPage() {
  return (
    <>
      <nav className="mb-2 text-sm text-slate-500" aria-label="Breadcrumb">
        <Link href="/properties" className="hover:underline">
          Properties
        </Link>
      </nav>
      <PageHeader
        title="Custom fields"
        description="Fields every listing can fill in, usable in guest messages as {{custom.key}}. Secret fields (door codes, Wi-Fi passwords) are encrypted and masked."
      />
      <Suspense fallback={<Skeleton lines={6} />}>
        <Fields />
      </Suspense>
    </>
  );
}

async function Fields() {
  const ctx = await requireAuthContext({ permission: "properties.manage", returnTo: "/properties/custom-fields" });
  const supabase = await createClient();
  const { data: fields } = await supabase
    .from("custom_fields")
    .select("id, key, label, field_type, options, position, archived_at")
    .eq("account_id", ctx.active.accountId)
    .order("archived_at", { nullsFirst: true })
    .order("label")
    .returns<CustomFieldRow[]>();
  return (
    <div className="space-y-6">
      <Card title="Add a field">
        <CustomFieldForm />
      </Card>
      <Card title="Fields">
        {fields?.length ? (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {fields.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-medium">{f.label}</span>
                <code className="text-xs">{`{{custom.${f.key}}}`}</code>
                <Badge tone={f.field_type === "secret" ? "amber" : "neutral"}>{CUSTOM_FIELD_TYPE_LABELS[f.field_type]}</Badge>
                {f.options.length ? <span className="text-xs text-slate-500">{f.options.join(", ")}</span> : null}
                {f.archived_at ? <Badge>Archived</Badge> : null}
                <form action={setCustomFieldArchived} className="ml-auto">
                  <input type="hidden" name="fieldId" value={f.id} />
                  <input type="hidden" name="archived" value={String(!f.archived_at)} />
                  <button type="submit" className="text-sm underline-offset-2 hover:underline">
                    {f.archived_at ? "Restore" : "Archive"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No custom fields yet.</p>
        )}
      </Card>
    </div>
  );
}
