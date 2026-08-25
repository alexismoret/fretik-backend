import { eq } from "drizzle-orm";
import db from "../../db";
import type { Collection } from "../../db/schema";
import { collections } from "../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";
import type { Audience } from "../../schemas/collection-sharing";
import {
  forgetCardIndexPolicy,
  reconcileCardIndexPolicy,
} from "../collection-records/card-indexing-policy";
import { reconcileTypeGrants } from "../collection-sharing/reconcile";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

/**
 * Patch the presentation + lifecycle fields of a collection, and/or its
 * cross-team `sharing`. `key` and `isSystem` are immutable here — the key drives
 * the typed view name (a rename is a separate, heavier code path) and `isSystem`
 * is set only at seed time.
 *
 * Sharing is OWNER-ONLY: `callerTeamId` (the session/JWT team) is checked against
 * the type's owner whenever `sharing` is present. Editing the audience reconciles
 * `collection_grants`; because records inherit live, this also re-scopes every
 * non-custom record of the type.
 */
export const updateCollection = async (data: {
  id: string;
  patch: {
    label?: string;
    labelPlural?: string | null;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    enabled?: boolean;
    /** `null` restores the size heuristic — see `card-indexing-policy.ts`. */
    semanticIndex?: boolean | null;
  };
  sharing?: Audience;
  /** Session team — asserted to own the type when `sharing` is set. */
  callerTeamId?: string;
  createdByUserId?: string | null;
  actor?: EventActor;
}): Promise<Collection> => {
  const { id, patch } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;
  // A sharing-only edit sends an empty patch — Drizzle's `.set({})` throws
  // "No values to set", so only run the UPDATE when a field actually changes;
  // otherwise just load the row (for the owner check + return).
  const hasPatch = Object.values(patch).some((v) => v !== undefined);

  const row = await db.transaction(async (tx) => {
    const row = hasPatch
      ? (
          await tx
            .update(collections)
            .set({ ...patch })
            .where(eq(collections.id, id))
            .returning()
        )[0]
      : await tx.query.collections.findFirst({ where: { id } });
    if (!row) {
      return throwHttpError(404, notFound("Collection not found"));
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
        collectionId: row.id,
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
        type: "collection.updated",
        actor,
        subjectType: "collection",
        payload: {
          collectionId: row.id,
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

  // Semantic indexing is a stored policy with a cached verdict and existing
  // vectors behind it — changing the setting has to move both, or it is a
  // switch that reports one thing and does another. Outside the transaction:
  // the vectors are a derived index, not part of the catalog write, and a
  // Redis hiccup must not roll back a rename.
  if (patch.semanticIndex !== undefined) {
    await forgetCardIndexPolicy(row.id);
    await reconcileCardIndexPolicy({ collectionId: row.id });
  }
  return row;
};
