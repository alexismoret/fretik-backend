import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition, ObjectType } from "../../db/schema";
import { objectTypes } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * List the object types a team can see: its own team-scoped types plus the
 * org/system ones (`teamId IS NULL`). This is the double-arm scope the rest of
 * the dynamic-data system uses. Disabled types are hidden unless
 * `includeDisabled` is set. Ordered by label.
 */
export const listObjectTypes = async (data: {
  organizationId: string;
  teamId: string;
  includeDisabled?: boolean;
}): Promise<ObjectType[]> => {
  const { organizationId, teamId, includeDisabled = false } = data;

  const scope = or(
    eq(objectTypes.teamId, teamId),
    and(
      isNull(objectTypes.teamId),
      eq(objectTypes.organizationId, organizationId),
    ),
  );
  const conditions = includeDisabled
    ? scope
    : and(scope, eq(objectTypes.enabled, true));

  return await db
    .select()
    .from(objectTypes)
    .where(conditions)
    .orderBy(asc(sql`lower(${objectTypes.label})`));
};

/**
 * Fetch a single object type with its field definitions (the runtime field
 * catalog used to build the record shape and render the panel).
 */
export const getObjectType = async (data: {
  id: string;
}): Promise<ObjectType & { fieldDefinitions: FieldDefinition[] }> => {
  const row = await db.query.objectTypes.findFirst({
    where: { id: data.id },
    with: { fieldDefinitions: true },
  });
  if (!row) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  return row;
};
