"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert, Badge, Button, Input, Select, formatDateTime } from "@/components/ui";
import {
  CLEANING_STATUSES,
  CLEANING_STATUS_LABELS,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_TONE,
  type CleaningStatus,
  type ListingStatus,
} from "@/lib/properties/constants";

import { ActionForm } from "../../_components/action-form";
import { addSubUnits, convertSubUnit, moveSubUnit, setCleaningStatus, setSubUnitArchived } from "./actions";

export function AddSubUnitsForm({ parentId }: { parentId: string }) {
  const [state, action, pending] = useActionState(addSubUnits.bind(null, parentId), null);
  return (
    <form action={action} className="space-y-2">
      <label htmlFor="add-units" className="block text-sm font-medium">
        Add sub-units
      </label>
      <div className="flex flex-wrap gap-2">
        <Input id="add-units" name="names" placeholder="Unit 101, Unit 102 — or a number" className="w-80" required />
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}
    </form>
  );
}

export function SubUnitRow({
  parentId,
  unit,
  timezone,
  otherParents,
  canEdit,
  canManage,
}: {
  parentId: string;
  unit: { id: string; name: string; status: ListingStatus; cleaningStatus: CleaningStatus; cleaningUpdatedAt: string | null };
  timezone: string;
  otherParents: { id: string; internal_name: string }[];
  canEdit: boolean;
  canManage: boolean;
}) {
  const [cleanState, cleanAction, cleanPending] = useActionState(setCleaningStatus, null);
  const [moving, setMoving] = useState(false);
  const [moveState, moveAction, movePending] = useActionState(moveSubUnit, null);
  const archived = unit.status === "archived";

  return (
    <li className="flex flex-wrap items-center gap-3 py-3 text-sm">
      <div className="min-w-40 flex-1">
        <Link href={`/properties/${unit.id}`} className="font-medium hover:underline">
          {unit.name}
        </Link>
        <p className="text-xs text-slate-500">
          Next arrival: — <span className="sr-only">(available once reservations are built)</span>
        </p>
      </div>
      <Badge tone={LISTING_STATUS_TONE[unit.status]}>{LISTING_STATUS_LABELS[unit.status]}</Badge>
      {!archived ? (
        <form action={cleanAction} className="flex items-center gap-2">
          <input type="hidden" name="ids" value={unit.id} />
          <label className="sr-only" htmlFor={`clean-${unit.id}`}>
            Cleaning status of {unit.name}
          </label>
          <Select
            id={`clean-${unit.id}`}
            name="status"
            defaultValue={unit.cleaningStatus}
            disabled={!canEdit || cleanPending}
            className="w-36"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {CLEANING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CLEANING_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <span className="hidden text-xs text-slate-500 md:inline">{unit.cleaningUpdatedAt ? `since ${formatDateTime(unit.cleaningUpdatedAt, timezone)}` : ""}</span>
          {cleanState?.error ? <span className="text-xs text-red-600">{cleanState.error}</span> : null}
        </form>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {!archived && otherParents.length ? (
            <Button type="button" variant="ghost" onClick={() => setMoving((m) => !m)}>
              Move
            </Button>
          ) : null}
          {!archived ? (
            <ActionForm
              action={convertSubUnit}
              fields={{ subUnitId: unit.id, parentId }}
              label="Make single unit"
              variant="ghost"
              confirm={`Turn ${unit.name} into a standalone single unit? It gets a copy of the parent's content and prices.`}
            />
          ) : null}
          <ActionForm
            action={setSubUnitArchived}
            fields={{ subUnitId: unit.id, archive: String(!archived) }}
            label={archived ? "Restore" : "Remove"}
            variant={archived ? "secondary" : "ghost"}
            confirm={archived ? undefined : `Remove ${unit.name}? It is archived (history kept) and takes no new bookings.`}
          />
        </div>
      ) : null}
      {moving ? (
        <form action={moveAction} className="flex w-full flex-wrap items-center gap-2 pl-4">
          <input type="hidden" name="subUnitId" value={unit.id} />
          <input type="hidden" name="parentId" value={parentId} />
          <label htmlFor={`move-${unit.id}`} className="text-sm">
            Move to
          </label>
          <Select id={`move-${unit.id}`} name="newParentId" className="w-64">
            {otherParents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.internal_name}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={movePending}>
            Move
          </Button>
          {moveState?.error ? <Alert tone="error">{moveState.error}</Alert> : null}
        </form>
      ) : null}
    </li>
  );
}
