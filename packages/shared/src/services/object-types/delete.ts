import { eq } from "drizzle-orm";
import db from "../../db";
import { objectTypes } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { dropTypedView } from "./sync-typed-view";

/**
 * Delete an object type. The `document` type is refused — it anchors the
 * uploaded-file record mirror and every document field definition, so the
 * upload pipeline depends on it. Every other type (including the seeded
 * company/person/note/task) is deletable; the FK cascade removes its records,
 * field definitions, and link types.
 */
export const deleteObjectType = async (data: {
  id: string;
}): Promise<{ id: string }> => {
  const { id } = data;

  const existing = await db.query.objectTypes.findFirst({
    columns: { id: true, key: true, teamId: true },
    where: { id },
  });
  if (!existing) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  if (existing.key === "document") {
    return throwHttpError(
      400,
      badRequest(
        "The 'document' object type cannot be deleted: it anchors uploaded files and their field definitions.",
      ),
    );
  }

  // Delete the row and drop its orphaned typed view in ONE tx (idempotent
  // DROP) — atomic, and cheap (metadata-only). Only team-scoped types own a
  // single view; org/system types span every team's views, repaired by
  // `scripts/sync-typed-views.ts` rather than dropped piecemeal here.
  return db.transaction(async (tx) => {
    await tx.delete(objectTypes).where(eq(objectTypes.id, id));
    if (existing.teamId) {
      await dropTypedView({
        tx,
        typeKey: existing.key,
        teamId: existing.teamId,
      });
    }
    return { id };
  });
};
