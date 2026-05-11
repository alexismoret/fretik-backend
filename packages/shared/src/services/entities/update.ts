import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { documentEntities, entities } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type {
  MergeEntityInput,
  UpdateEntityInput,
} from "../../schemas/entities";
import { normalizeEntityName } from "../../utils/normalizeEntityName";
import { triggerEntityEnrichment } from "./enrichment";

/**
 * Updates an entity.
 * If status changes to "confirmed", triggers enrichment.
 */
export const updateEntity = async (data: {
  id: string;
  teamId: string;
  input: UpdateEntityInput;
}) => {
  const { id, teamId, input } = data;

  const existing = await db.query.entities.findFirst({
    where: { id, teamId },
  });

  if (!existing) {
    return throwHttpError(404, notFound("Entity not found"));
  }

  const updateData: Partial<typeof entities.$inferInsert> = {};

  if (input.name !== undefined) {
    updateData.name = input.name;
    updateData.normalizedName =
      normalizeEntityName(input.name) || input.name.toLowerCase().trim();
  }
  if (input.type !== undefined) {
    updateData.type = input.type;
  }
  if (input.aliases !== undefined) {
    updateData.aliases = input.aliases.map(normalizeEntityName).filter(Boolean);
  }
  if (input.notes !== undefined) {
    updateData.notes = input.notes;
  }
  if (input.status !== undefined) {
    updateData.status = input.status;
  }

  const result = await db
    .update(entities)
    .set(updateData)
    .where(eq(entities.id, id))
    .returning();

  const updated = result[0]!;

  // If confirming a suggested entity, trigger enrichment
  if (input.status === "confirmed" && existing.status === "suggested") {
    triggerEntityEnrichment(updated.id);
  }

  return updated;
};

/**
 * Merges a source entity into a target entity.
 * - Moves all document-entity links from source to target
 * - Adds source's normalized name and aliases to target's aliases
 * - Deletes the source entity
 */
export const mergeEntity = async (data: {
  sourceId: string;
  teamId: string;
  input: MergeEntityInput;
}) => {
  const { sourceId, teamId, input } = data;

  const [source, target] = await Promise.all([
    db.query.entities.findFirst({ where: { id: sourceId, teamId } }),
    db.query.entities.findFirst({
      where: { id: input.targetEntityId, teamId },
    }),
  ]);

  if (!source) {
    return throwHttpError(404, notFound("Source entity not found"));
  }
  if (!target) {
    return throwHttpError(404, notFound("Target entity not found"));
  }

  return db.transaction(async (tx) => {
    // Reassign document links from source to target (skip conflicts)
    const sourceLinks = await tx
      .select()
      .from(documentEntities)
      .where(eq(documentEntities.entityId, sourceId));

    for (const link of sourceLinks) {
      await tx
        .insert(documentEntities)
        .values({
          documentId: link.documentId,
          entityId: input.targetEntityId,
          role: link.role,
          source: link.source,
          confidence: link.confidence,
          rawExtractedName: link.rawExtractedName,
        })
        .onConflictDoNothing({
          target: [
            documentEntities.documentId,
            documentEntities.entityId,
            documentEntities.role,
          ],
        });
    }

    // Delete source links
    await tx
      .delete(documentEntities)
      .where(eq(documentEntities.entityId, sourceId));

    // Add source's normalized name and aliases to target's aliases
    const newAliases = [
      ...new Set([...target.aliases, source.normalizedName, ...source.aliases]),
    ].filter((a) => a !== target.normalizedName);

    await tx
      .update(entities)
      .set({ aliases: newAliases })
      .where(eq(entities.id, input.targetEntityId));

    // Delete source entity
    await tx.delete(entities).where(eq(entities.id, sourceId));

    return target;
  });
};

/**
 * Adds an alias to an entity (used when user corrects a document-entity link).
 */
export const addEntityAlias = async (data: {
  entityId: string;
  alias: string;
}) => {
  const normalized = normalizeEntityName(data.alias);
  if (!normalized) return;

  await db.execute(sql`
    UPDATE entities
    SET aliases = CASE
      WHEN ${normalized} = ANY(aliases) THEN aliases
      ELSE array_append(aliases, ${normalized})
    END
    WHERE id = ${data.entityId}
  `);
};
