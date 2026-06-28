import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition, ObjectType } from "../../db/schema";
import { objectTypes } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { typeGrantedExists } from "../object-sharing/access";

/**
 * List the object types a team can see: its own team-scoped types, the
 * org/system ones (`teamId IS NULL`), AND types another team has shared with it
 * (a type-level grant, or org-wide). The shared-in ones carry the OWNER's
 * `teamId`, so the caller distinguishes them from the team's own. Disabled types
 * are hidden unless `includeDisabled` is set. Ordered by label.
 */
export const listObjectTypes = async (data: {
  organizationId: string;
  teamId: string;
  includeDisabled?: boolean;
}): Promise<ObjectType[]> => {
  const { organizationId, teamId, includeDisabled = false } = data;

  const scope = and(
    eq(objectTypes.organizationId, organizationId),
    or(
      eq(objectTypes.teamId, teamId),
      isNull(objectTypes.teamId),
      typeGrantedExists(teamId, organizationId),
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
  teamId: string;
}): Promise<ObjectType & { fieldDefinitions: FieldDefinition[] }> => {
  const row = await db.query.objectTypes.findFirst({ where: { id: data.id } });
  if (!row) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  // Fields live under the type's OWNER team. For the team's own / a shared-in
  // foreign type that is the type's `teamId`; for a system type (`teamId IS
  // NULL`, duplicated per team) it's the viewer's own team. Scoping this way
  // avoids showing every field twice (org template + team copy) AND renders a
  // foreign type's fields correctly.
  const fieldTeamId = row.teamId ?? data.teamId;
  const fieldDefinitions = await db.query.fieldDefinitions.findMany({
    where: { objectTypeId: data.id, teamId: fieldTeamId },
  });
  return { ...row, fieldDefinitions };
};
