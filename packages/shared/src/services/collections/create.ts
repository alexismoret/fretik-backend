import db from "../../db";
import type { Collection } from "../../db/schema";
import { collections } from "../../db/schema";
import { autoColorForKey } from "../../lib/colors/collection-colors";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import type { Audience } from "../../schemas/collection-sharing";
import { reconcileCollectionTable } from "../collection-schema/table";
import { reconcileTypeGrants } from "../collection-sharing/reconcile";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { invalidateCollectionIdCache } from "./resolve";

/**
 * Stable slug grammar for `collections.key`: lowercase letter first, then
 * lowercase alphanumerics / underscores, ≤ 60 chars. The key drives the
 * typed view name the agent reads, so it is strictly validated here
 * (anti-DDL-injection).
 */
const COLLECTION_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
const MAX_KEY_LENGTH = 60;

/**
 * Lowercase a free-form key candidate and collapse non-alphanumeric runs to
 * underscores before the grammar check, so callers can pass a label-ish
 * value and still get a persistable key.
 */
const slugifyCollectionKey = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);

/**
 * Slugify + grammar-check a free-form key candidate, throwing 400 on failure.
 * The anti-DDL-injection boundary for the object-type key, shared by the plain
 * create path and the batched `create-with-fields` path.
 */
export const prepareCollectionKey = (rawKey: string): string => {
  const key = slugifyCollectionKey(rawKey);
  if (!COLLECTION_KEY_REGEX.test(key) || key.length > MAX_KEY_LENGTH) {
    return throwHttpError(
      400,
      badRequest(
        `Collection key '${rawKey}' is invalid. It must be lowercase, start with a letter, contain only letters, digits and underscores, and be at most ${MAX_KEY_LENGTH} characters.`,
      ),
    );
  }
  return key;
};

/**
 * Create a user-defined collection at team scope. `isSystem` is always false
 * — system types are seeded separately and protected from deletion.
 */
export const createCollection = async (input: {
  organizationId: string;
  teamId: string;
  key: string;
  label: string;
  labelPlural?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  // Initial cross-team audience. Default (omitted) = internal (owning team only).
  sharing?: Audience;
  createdByUserId?: string | null;
  actor?: EventActor;
}): Promise<Collection> => {
  const key = prepareCollectionKey(input.key);
  const actor =
    input.actor ??
    (input.createdByUserId
      ? { actorType: "user" as const, actorUserId: input.createdByUserId }
      : SYSTEM_ACTOR);

  // Create the type's extension table in the SAME tx as the type row — the
  // catalog mutation and its physical table commit atomically. Cheap: a new type
  // has no records, so this is metadata-only DDL.
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(collections)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        key,
        label: input.label,
        labelPlural: input.labelPlural ?? null,
        description: input.description ?? null,
        icon: input.icon ?? null,
        // Server owns the accent color — auto-assign a stable one when unset.
        color: input.color ?? autoColorForKey(key),
        isSystem: false,
      })
      .returning();
    if (!created) {
      return throwHttpError(500, internalError());
    }
    await reconcileCollectionTable({ tx, collectionId: created.id });
    if (input.sharing) {
      await reconcileTypeGrants({
        collectionId: created.id,
        ownerTeamId: input.teamId,
        organizationId: input.organizationId,
        audience: input.sharing,
        createdByUserId: input.createdByUserId ?? null,
        tx,
      });
    }
    await emitDomainEvent({
      tx,
      organizationId: input.organizationId,
      teamId: input.teamId,
      type: "collection.created",
      actor,
      subjectType: "collection",
      payload: { collectionId: created.id, key, label: input.label },
      dedupKey: `collection.created:${created.id}`,
    });
    return created;
  });

  // Bust any stale key→id cache so a recreate-after-delete (same key) resolves
  // to THIS new id, not the deleted one.
  await invalidateCollectionIdCache({
    organizationId: input.organizationId,
    teamId: input.teamId,
    key,
  });
  return row;
};
