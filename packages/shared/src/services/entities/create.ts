import db from "../../db";
import { entities } from "../../db/schema";
import type { CreateEntityInput } from "../../schemas/entities";
import { normalizeEntityName } from "../../utils/normalizeEntityName";
import { triggerEntityEnrichment } from "./enrichment";

/**
 * Creates a new confirmed entity.
 * Triggers enrichment placeholder.
 */
export const createEntity = async (data: {
  teamId: string;
  input: CreateEntityInput;
}) => {
  const { teamId, input } = data;
  const normalized = normalizeEntityName(input.name);
  const normalizedAliases = input.aliases
    .map(normalizeEntityName)
    .filter(Boolean);

  const result = await db
    .insert(entities)
    .values({
      teamId,
      status: "confirmed",
      type: input.type,
      name: input.name,
      normalizedName: normalized || input.name.toLowerCase().trim(),
      aliases: normalizedAliases,
      notes: input.notes,
    })
    .returning();

  const inserted = result[0]!;
  triggerEntityEnrichment(inserted.id);

  return inserted;
};
