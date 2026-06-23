import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import { linkTypes } from "../../db/schema";
import { FUZZY_MATCH_THRESHOLD } from "../../lib/resolution";
import { createLinkType } from "./create";

type ResolveLinkTypeResult = {
  linkTypeId: string;
  isNew: boolean;
};

const slugifyLinkTypeKey = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/**
 * Canonicalize a proposed relation against existing link types to prevent
 * predicate sprawl (`works_for` vs `employed_by`). Within the double-arm scope
 * (team + org/system) and the same `fromObjectTypeId`:
 *   1. exact `normalizedKey` match
 *   2. trigram similarity on `normalizedKey` >= FUZZY_MATCH_THRESHOLD (best
 *      match; deliberately strict — precision-first)
 *
 * On no match, creates a `suggested` link type. Returns the resolved id and
 * whether it is new. (Embedding-based matching is future work; the slug +
 * trigram pass is sufficient now.)
 */
export const resolveLinkType = async (data: {
  organizationId: string;
  teamId: string;
  rawKey: string;
  fromObjectTypeId: string;
  toObjectTypeId?: string | null;
}): Promise<ResolveLinkTypeResult> => {
  const { organizationId, teamId, rawKey, fromObjectTypeId, toObjectTypeId } =
    data;
  const normalizedKey = slugifyLinkTypeKey(rawKey);

  const scope = and(
    eq(linkTypes.fromObjectTypeId, fromObjectTypeId),
    or(
      eq(linkTypes.teamId, teamId),
      and(
        isNull(linkTypes.teamId),
        eq(linkTypes.organizationId, organizationId),
      ),
    ),
  );

  // Stage 1: exact normalized key.
  const [exact] = await db
    .select({ id: linkTypes.id })
    .from(linkTypes)
    .where(and(scope, eq(linkTypes.normalizedKey, normalizedKey)))
    .limit(1);
  if (exact) {
    return { linkTypeId: exact.id, isNew: false };
  }

  // Stage 2: trigram similarity on the normalized key.
  const sim = sql<number>`similarity(${linkTypes.normalizedKey}, ${normalizedKey})`;
  const [trigramMatch] = await db
    .select({ id: linkTypes.id, sim: sim.as("sim") })
    .from(linkTypes)
    .where(and(scope, sql`${sim} >= ${FUZZY_MATCH_THRESHOLD}`))
    .orderBy(desc(sql`sim`))
    .limit(1);
  if (trigramMatch) {
    return { linkTypeId: trigramMatch.id, isNew: false };
  }

  const created = await createLinkType({
    organizationId,
    teamId,
    key: rawKey,
    label: rawKey,
    fromObjectTypeId,
    toObjectTypeId: toObjectTypeId ?? null,
    status: "suggested",
    source: "ai_extraction",
  });
  return { linkTypeId: created.id, isNew: true };
};
