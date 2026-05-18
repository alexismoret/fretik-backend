import db from "../../db";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { invalidateFieldDefinitionsCache } from "./cache";
import {
  assertScopeEnabledCap,
  validateFieldDefinitionShape,
} from "./validate";

export type CreateFieldDefinitionInput = {
  organizationId: string;
  teamId: string | null;
  resourceType: FieldDefinition["resourceType"];
  key: string;
  label: string;
  description?: string | null;
  type: FieldDefinitionType;
  config?: FieldDefinitionConfig;
  aiExtractionEnabled?: boolean;
  vectorizeInclude?: boolean;
  displayInPanel?: boolean;
  displayInFilters?: boolean;
  enabled?: boolean;
  displayOrder?: number;
};

/**
 * Create a single field definition. Validates intrinsic shape (slug, lengths,
 * options cap) and the per-scope enabled cap before insert. Cache
 * invalidation is handled by the caller in the API handler.
 */
export const createFieldDefinition = async (
  input: CreateFieldDefinitionInput,
): Promise<FieldDefinition> => {
  validateFieldDefinitionShape({
    key: input.key,
    label: input.label,
    description: input.description ?? null,
    type: input.type,
    config: input.config,
  });

  const willBeEnabled = input.enabled ?? true;
  if (willBeEnabled) {
    await assertScopeEnabledCap({
      organizationId: input.organizationId,
      teamId: input.teamId,
      resourceType: input.resourceType,
      addEnabled: 1,
    });
  }

  const [row] = await db
    .insert(fieldDefinitions)
    .values({
      organizationId: input.organizationId,
      teamId: input.teamId,
      resourceType: input.resourceType,
      key: input.key,
      label: input.label,
      description: input.description ?? null,
      type: input.type,
      config: input.config ?? {},
      aiExtractionEnabled: input.aiExtractionEnabled ?? true,
      vectorizeInclude: input.vectorizeInclude ?? true,
      displayInPanel: input.displayInPanel ?? true,
      displayInFilters: input.displayInFilters ?? false,
      enabled: willBeEnabled,
      displayOrder: input.displayOrder ?? 0,
    })
    .returning();
  if (!row) {
    return throwHttpError(500, internalError());
  }
  await invalidateFieldDefinitionsCache({
    organizationId: input.organizationId,
    teamId: input.teamId,
  });
  return row;
};
