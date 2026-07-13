import { eq } from "drizzle-orm";
import db from "../../db";
import type { ObjectType } from "../../db/schema";
import { objectTypes } from "../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";
import type { Audience } from "../../schemas/object-sharing";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { reconcileTypeGrants } from "../object-sharing/reconcile";

/**
 * Patch the presentation + lifecycle fields of an object type, and/or its
 * cross-team `sharing`. `key` and `isSystem` are immutable here — the key drives
 * the typed view name (a rename is a separate, heavier code path) and `isSystem`
 * is set only at seed time.
 *
 * Sharing is OWNER-ONLY: `callerTeamId` (the session/JWT team) is checked against
 * the type's owner whenever `sharing` is present. Editing the audience reconciles
 * `object_grants`; because records inherit live, this also re-scopes every
 * non-custom record of the type.
 */
export const updateObjectType = async (data: {
  id: string;
  patch: {
    label?: string;
    labelPlural?: string | null;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    enabled?: boolean;
  };
  sharing?: Audience;
  /** Session team — asserted to own the type when `sharing` is set. */
  callerTeamId?: string;
  createdByUserId?: string | null;
  actor?: EventActor;
}): Promise<ObjectType> => {
  const { id, patch } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;
  // A sharing-only edit sends an empty patch — Drizzle's `.set({})` throws
  // "No values to set", so only run the UPDATE when a field actually changes;
  // otherwise just load the row (for the owner check + return).
  const hasPatch = Object.values(patch).some((v) => v !== undefined);

  return db.transaction(async (tx) => {
    const row = hasPatch
      ? (
          await tx
            .update(objectTypes)
            .set({ ...patch })
            .where(eq(objectTypes.id, id))
            .returning()
        )[0]
      : await tx.query.objectTypes.findFirst({ where: { id } });
    if (!row) {
      return throwHttpError(404, notFound("Object type not found"));
    }

    if (data.sharing) {
      // Org/system types (teamId null) are already org-visible — not shareable.
      if (
        row.teamId === null ||
        (data.callerTeamId !== undefined && row.teamId !== data.callerTeamId)
      ) {
        return throwHttpError(
          403,
          forbidden("Only the owning team can change sharing"),
        );
      }
      await reconcileTypeGrants({
        objectTypeId: row.id,
        ownerTeamId: row.teamId,
        organizationId: row.organizationId,
        audience: data.sharing,
        createdByUserId: data.createdByUserId ?? null,
        tx,
      });
    }

    // Journal the catalog change. Org/system types (teamId null) are outside
    // the team-scoped journal — skipped.
    if (row.teamId && (hasPatch || data.sharing)) {
      await emitDomainEvent({
        tx,
        organizationId: row.organizationId,
        teamId: row.teamId,
        type: "object_type.updated",
        actor,
        subjectType: "object_type",
        payload: {
          objectTypeId: row.id,
          key: row.key,
          changed: [
            ...Object.keys(patch).filter(
              (k) => patch[k as keyof typeof patch] !== undefined,
            ),
            ...(data.sharing ? ["sharing"] : []),
          ],
        },
      });
    }
    return row;
  });
};
