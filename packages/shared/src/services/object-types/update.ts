import { eq } from "drizzle-orm";
import db from "../../db";
import type { ObjectType } from "../../db/schema";
import { objectTypes } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * Patch the presentation + lifecycle fields of an object type. `key` and
 * `isSystem` are immutable here — the key drives the typed view name (a rename
 * is a separate, heavier code path) and `isSystem` is set only at seed time.
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
}): Promise<ObjectType> => {
  const { id, patch } = data;

  const [row] = await db
    .update(objectTypes)
    .set({ ...patch })
    .where(eq(objectTypes.id, id))
    .returning();
  if (!row) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  return row;
};
