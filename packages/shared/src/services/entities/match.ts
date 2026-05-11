import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../db";
import {
  documentEntities,
  entities,
  type EntityRole,
  type EntityType,
  type NewDocumentEntity,
  type NewEntity,
} from "../../db/schema";
import { normalizeEntityName } from "../../utils/normalizeEntityName";

type MatchResult = {
  entityId: string;
  confidence: number;
  isNew: boolean;
};

/**
 * Attempts to match an extracted entity name against existing confirmed entities
 * using a 3-stage cascade: exact normalized → aliases → trigram similarity.
 *
 * If no match is found, creates a "suggested" entity.
 */
export const matchEntity = async (data: {
  teamId: string;
  rawName: string;
  type: EntityType;
}): Promise<MatchResult> => {
  const { teamId, rawName, type } = data;
  const normalized = normalizeEntityName(rawName);

  if (!normalized) {
    return createSuggestedEntity({
      teamId,
      rawName,
      normalized: rawName.toLowerCase().trim(),
      type,
    });
  }

  // Stage 1: Exact normalized name match (confirmed entities only)
  const exactMatch = await db.query.entities.findFirst({
    columns: { id: true },
    where: {
      teamId,
      normalizedName: normalized,
      status: "confirmed",
    },
  });

  if (exactMatch) {
    return { entityId: exactMatch.id, confidence: 1.0, isNew: false };
  }

  // Stage 2: Alias array match (confirmed entities only)
  // Uses raw SQL for the @> array contains operator
  const [aliasMatch] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.teamId, teamId),
        eq(entities.status, "confirmed"),
        sql`${entities.aliases} @> ARRAY[${normalized}]::text[]`,
      ),
    )
    .limit(1);

  if (aliasMatch) {
    return { entityId: aliasMatch.id, confidence: 1.0, isNew: false };
  }

  // Stage 3: Trigram similarity (requires pg_trgm extension)
  const sim = sql<number>`similarity(${entities.normalizedName}, ${normalized})`;

  const [trigramMatch] = await db
    .select({ id: entities.id, sim: sim.as("sim") })
    .from(entities)
    .where(
      and(
        eq(entities.teamId, teamId),
        eq(entities.status, "confirmed"),
        sql`${sim} > 0.4`,
      ),
    )
    .orderBy(desc(sql`sim`))
    .limit(1);

  if (trigramMatch) {
    return {
      entityId: trigramMatch.id,
      confidence: trigramMatch.sim,
      isNew: false,
    };
  }

  // Check if a rejected entity with this normalized name exists — skip creation
  const rejectedMatch = await db.query.entities.findFirst({
    columns: { id: true },
    where: {
      teamId,
      normalizedName: normalized,
      status: "rejected",
    },
  });

  if (rejectedMatch) {
    return { entityId: rejectedMatch.id, confidence: 0, isNew: false };
  }

  // Check if a suggested entity already exists
  const existingSuggestion = await db.query.entities.findFirst({
    columns: { id: true },
    where: {
      teamId,
      normalizedName: normalized,
      status: "suggested",
    },
  });

  if (existingSuggestion) {
    return { entityId: existingSuggestion.id, confidence: 0, isNew: false };
  }

  return createSuggestedEntity({ teamId, rawName, normalized, type });
};

/**
 * Creates a new "suggested" entity.
 */
const createSuggestedEntity = async (data: {
  teamId: string;
  rawName: string;
  normalized: string;
  type: EntityType;
}): Promise<MatchResult> => {
  const newEntity: NewEntity = {
    teamId: data.teamId,
    status: "suggested",
    type: data.type,
    name: data.rawName,
    normalizedName: data.normalized,
    aliases: [],
  };

  const result = await db
    .insert(entities)
    .values(newEntity)
    .returning({ id: entities.id });

  return { entityId: result[0]!.id, confidence: 0, isNew: true };
};

/**
 * Matches all entities from a pre-extraction result and creates document-entity links.
 * Called after the pre-extract pipeline returns.
 */
export const matchAndLinkEntities = async (data: {
  teamId: string;
  documentId: string;
  extractedEntities: Array<{
    name: string;
    role: EntityRole;
    type?: EntityType;
    confidence?: number;
  }>;
}) => {
  const { teamId, documentId, extractedEntities } = data;

  for (const extracted of extractedEntities) {
    // Use AI-provided type if available, otherwise infer from role
    const type = extracted.type ?? inferEntityType(extracted.role);
    const match = await matchEntity({ teamId, rawName: extracted.name, type });

    // Skip rejected entities — don't create links
    if (match.confidence === 0 && !match.isNew) {
      const entity = await db.query.entities.findFirst({
        columns: { status: true },
        where: { id: match.entityId },
      });
      if (entity?.status === "rejected") {
        continue;
      }
    }

    const linkData: NewDocumentEntity = {
      documentId,
      entityId: match.entityId,
      role: extracted.role,
      source: "ai_extraction",
      confidence: String(
        match.confidence > 0 ? match.confidence : (extracted.confidence ?? 0),
      ),
      rawExtractedName: extracted.name,
    };

    await db
      .insert(documentEntities)
      .values(linkData)
      .onConflictDoNothing({
        target: [
          documentEntities.documentId,
          documentEntities.entityId,
          documentEntities.role,
        ],
      });
  }
};

/**
 * Fallback: infers entity type from the role context.
 * Only used when the pre-extract pipeline doesn't provide a type.
 */
const inferEntityType = (role: EntityRole): EntityType => {
  switch (role) {
    case "customer":
    case "consignee":
    case "shipper":
      return "client";
    case "issuer":
    case "broker":
    case "mentioned":
      return "other";
    default:
      return "other";
  }
};
