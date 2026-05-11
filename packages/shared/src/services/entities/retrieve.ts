import { and, count, eq, sql } from "drizzle-orm";
import db from "../../db";
import {
  documentEntities,
  entities,
  type EntityStatus,
  type EntityType,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import { normalizeEntityName } from "../../utils/normalizeEntityName";

/**
 * Enriches an entity with a presigned image URL.
 */
const withImageUrl = async <T extends { imageS3Key: string | null }>(
  entity: T,
): Promise<T & { imageUrl: string | null }> => ({
  ...entity,
  imageUrl: entity.imageS3Key ? await getPresignedUrl(entity.imageS3Key) : null,
});

/**
 * Gets entity counts by status for tab badges.
 */
export const getEntityCounts = async (data: { teamId: string }) => {
  const results = await db
    .select({
      status: entities.status,
      count: count(),
    })
    .from(entities)
    .where(eq(entities.teamId, data.teamId))
    .groupBy(entities.status);

  const counts = { confirmed: 0, suggested: 0, rejected: 0 };
  for (const row of results) {
    counts[row.status] = row.count;
  }
  return counts;
};

/**
 * Lists entities with pagination, filtering, and document count.
 */
export const listEntities = async (data: {
  teamId: string;
  status?: EntityStatus;
  type?: EntityType;
  search?: string;
  limit: number;
  offset: number;
}) => {
  const { teamId, status, type, search, limit, offset } = data;

  const conditions = [eq(entities.teamId, teamId)];

  if (status) {
    conditions.push(eq(entities.status, status));
  }
  if (type) {
    conditions.push(eq(entities.type, type));
  }
  if (search) {
    const normalizedSearch = normalizeEntityName(search);
    conditions.push(
      sql`(
        ${entities.normalizedName} ILIKE ${"%" + normalizedSearch + "%"}
        OR ${entities.name} ILIKE ${"%" + search + "%"}
        OR ${entities.aliases}::text ILIKE ${"%" + normalizedSearch + "%"}
      )`,
    );
  }

  const whereClause = and(...conditions);

  const [items, [totalResult]] = await Promise.all([
    db
      .select({
        id: entities.id,
        teamId: entities.teamId,
        status: entities.status,
        type: entities.type,
        name: entities.name,
        normalizedName: entities.normalizedName,
        aliases: entities.aliases,
        notes: entities.notes,
        imageS3Key: entities.imageS3Key,
        website: entities.website,
        address: entities.address,
        country: entities.country,
        phone: entities.phone,
        email: entities.email,
        enrichmentStatus: entities.enrichmentStatus,
        enrichedAt: entities.enrichedAt,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        documentCount: sql<number>`(
          SELECT COUNT(*)::int FROM document_entities
          WHERE document_entities.entity_id = ${entities.id}
        )`.as("document_count"),
      })
      .from(entities)
      .where(whereClause)
      .orderBy(entities.name)
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(entities).where(whereClause),
  ]);

  const enriched = await Promise.all(items.map(withImageUrl));

  return { count: totalResult?.total ?? 0, data: enriched };
};

/**
 * Gets a single entity by ID with document count.
 *
 * `includeLinkedDocuments` (default `false`) opts into a full list of
 * linked documents (id, filename, role, source, confidence) via the
 * `documentEntities` relation — used by the chatbot's `getEntityDetails`
 * tool. The drive UI and the API entity handler leave it off so the
 * default payload stays light.
 */
export const getEntity = async (data: {
  id: string;
  teamId: string;
  includeLinkedDocuments?: boolean;
}) => {
  const { includeLinkedDocuments = false } = data;

  const entity = await db.query.entities.findFirst({
    where: { id: data.id, teamId: data.teamId },
    ...(includeLinkedDocuments && {
      with: {
        documentEntities: {
          columns: {
            role: true,
            source: true,
            confidence: true,
            rawExtractedName: true,
            createdAt: true,
          },
          with: {
            document: {
              columns: {
                id: true,
                originalFilename: true,
                mimeType: true,
                status: true,
                createdAt: true,
              },
            },
          },
        },
      },
    }),
  });

  if (!entity) {
    return throwHttpError(404, notFound("Entity not found"));
  }

  const [docCountResult] = await db
    .select({ docCount: count() })
    .from(documentEntities)
    .where(eq(documentEntities.entityId, data.id));

  return withImageUrl({
    ...entity,
    documentCount: docCountResult?.docCount ?? 0,
  });
};

/**
 * Gets document-entity links for a specific document.
 */
export const getDocumentEntities = async (data: { documentId: string }) => {
  const links = await db.query.documentEntities.findMany({
    where: { documentId: data.documentId },
    with: {
      entity: {
        columns: {
          id: true,
          name: true,
          type: true,
          status: true,
          imageS3Key: true,
        },
      },
    },
  });

  const validLinks = links.filter(
    (link): link is typeof link & { entity: NonNullable<typeof link.entity> } =>
      link.entity !== null,
  );

  return Promise.all(
    validLinks.map(async (link) => ({
      ...link,
      entity: {
        ...link.entity,
        imageUrl: link.entity.imageS3Key
          ? await getPresignedUrl(link.entity.imageS3Key)
          : null,
      },
    })),
  );
};
