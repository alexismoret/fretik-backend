import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import type { LinkType } from "../../db/schema";
import { linkTypes } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * List the link types a team can see: its own plus the org/system ones
 * (`teamId IS NULL`) — the double-arm scope. Optionally narrowed to relations
 * starting from a given collection. Ordered by label.
 */
export const listLinkTypes = async (data: {
  organizationId: string;
  teamId: string;
  fromCollectionId?: string;
}): Promise<LinkType[]> => {
  const { organizationId, teamId, fromCollectionId } = data;

  const scope = or(
    eq(linkTypes.teamId, teamId),
    and(isNull(linkTypes.teamId), eq(linkTypes.organizationId, organizationId)),
  );
  const conditions = fromCollectionId
    ? and(scope, eq(linkTypes.fromCollectionId, fromCollectionId))
    : scope;

  return await db
    .select()
    .from(linkTypes)
    .where(conditions)
    .orderBy(asc(sql`lower(${linkTypes.label})`));
};

export const getLinkType = async (data: { id: string }): Promise<LinkType> => {
  const row = await db.query.linkTypes.findFirst({ where: { id: data.id } });
  if (!row) {
    return throwHttpError(404, notFound("Link type not found"));
  }
  return row;
};
