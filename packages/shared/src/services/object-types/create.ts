import db from "../../db";
import type { ObjectType } from "../../db/schema";
import { objectTypes } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import { syncTypedView } from "./sync-typed-view";

/**
 * Stable slug grammar for `object_types.key`: lowercase letter first, then
 * lowercase alphanumerics / underscores, ≤ 60 chars. The key drives the
 * typed view name the agent reads, so it is strictly validated here
 * (anti-DDL-injection).
 */
const OBJECT_TYPE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
const MAX_KEY_LENGTH = 60;

/**
 * Lowercase a free-form key candidate and collapse non-alphanumeric runs to
 * underscores before the grammar check, so callers can pass a label-ish
 * value and still get a persistable key.
 */
const slugifyObjectTypeKey = (raw: string): string =>
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
export const prepareObjectTypeKey = (rawKey: string): string => {
  const key = slugifyObjectTypeKey(rawKey);
  if (!OBJECT_TYPE_KEY_REGEX.test(key) || key.length > MAX_KEY_LENGTH) {
    return throwHttpError(
      400,
      badRequest(
        `Object type key '${rawKey}' is invalid. It must be lowercase, start with a letter, contain only letters, digits and underscores, and be at most ${MAX_KEY_LENGTH} characters.`,
      ),
    );
  }
  return key;
};

/**
 * Create a user-defined object type at team scope. `isSystem` is always false
 * — system types are seeded separately and protected from deletion.
 */
export const createObjectType = async (input: {
  organizationId: string;
  teamId: string;
  key: string;
  label: string;
  labelPlural?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}): Promise<ObjectType> => {
  const key = prepareObjectTypeKey(input.key);

  // Create the typed view in the SAME tx as the type row — a catalog mutation
  // and its derived view commit atomically. Cheap: a new type has no records,
  // so this is metadata-only DDL (no embedding / vectorize work runs here). The
  // perf-only expression indexes inside `syncTypedView` stay best-effort
  // (savepoint-isolated) so they can never abort this.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(objectTypes)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        key,
        label: input.label,
        labelPlural: input.labelPlural ?? null,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        isSystem: false,
      })
      .returning();
    if (!row) {
      return throwHttpError(500, internalError());
    }
    await syncTypedView({ tx, objectTypeId: row.id, teamId: input.teamId });
    return row;
  });
};
