import { and, eq, isNull, ne } from "drizzle-orm";
import db from "../../db";
import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";
import { collections, fieldDefinitions } from "../../db/schema";
import { fieldOptions } from "../../db/schema/field-types";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  FIELD_DEFINITION_KEY_REGEX,
  FIELD_DEFINITION_LIMITS,
} from "./constants";

export type FieldDefinitionPatch = {
  key?: string;
  label?: string;
  description?: string | null;
  type?: FieldDefinitionType;
  config?: FieldDefinitionConfig;
  isTitle?: boolean;
  aiExtractionEnabled?: boolean;
  vectorizeInclude?: boolean;
  displayInPanel?: boolean;
  enabled?: boolean;
  displayOrder?: number;
};

/**
 * Validate a single field's intrinsic shape (label/description length,
 * options cap, slug grammar). Throws 400 on the first failure.
 */
export const validateFieldDefinitionShape = (
  patch: FieldDefinitionPatch & { key?: string },
): void => {
  if (patch.key !== undefined && !FIELD_DEFINITION_KEY_REGEX.test(patch.key)) {
    return throwHttpError(
      400,
      badRequest(
        `Field key '${patch.key}' must match ${FIELD_DEFINITION_KEY_REGEX} (lowercase, alphanum + underscore, 1-60 chars).`,
      ),
    );
  }
  if (
    patch.label !== undefined &&
    patch.label.length > FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS
  ) {
    return throwHttpError(
      400,
      badRequest(
        `Label exceeds ${FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS} chars.`,
      ),
    );
  }
  if (
    patch.description != null &&
    patch.description.length > FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS
  ) {
    return throwHttpError(
      400,
      badRequest(
        `Description exceeds ${FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS} chars.`,
      ),
    );
  }
  const options = patch.config ? fieldOptions(patch.config) : [];
  if (options.length > FIELD_DEFINITION_LIMITS.MAX_OPTIONS_PER_FIELD) {
    return throwHttpError(
      400,
      badRequest(
        `Too many options (${options.length}); max ${FIELD_DEFINITION_LIMITS.MAX_OPTIONS_PER_FIELD}.`,
      ),
    );
  }
  if (
    (patch.type === "select" || patch.type === "multi_select") &&
    options.length === 0
  ) {
    return throwHttpError(
      400,
      badRequest(
        "Select / multi_select fields require at least one option in config.options.",
      ),
    );
  }
  if (patch.type === "rollup" && patch.config) {
    const cfg = patch.config;
    const relationFieldKey =
      "relationFieldKey" in cfg ? cfg.relationFieldKey : undefined;
    const fn = "fn" in cfg ? cfg.fn : undefined;
    const targetFieldKey =
      "targetFieldKey" in cfg ? cfg.targetFieldKey : undefined;
    if (!relationFieldKey || !fn) {
      return throwHttpError(
        400,
        badRequest(
          "Rollup fields require config.relationFieldKey and config.fn.",
        ),
      );
    }
    const numericFn =
      fn === "sum" || fn === "avg" || fn === "min" || fn === "max";
    if (numericFn && !targetFieldKey) {
      return throwHttpError(
        400,
        badRequest(
          `Rollup fn '${fn}' requires config.targetFieldKey (the field to aggregate).`,
        ),
      );
    }
  }
};

/**
 * Count enabled definitions in a scope, optionally excluding one id (used
 * during create/update to forecast the post-operation count). Returns the
 * count so callers can compare against
 * `FIELD_DEFINITION_LIMITS.MAX_ENABLED_PER_SCOPE`.
 */
export const countEnabledForScope = async (data: {
  organizationId: string;
  teamId: string | null;
  collectionId: string;
  excludeId?: string;
}): Promise<number> => {
  const { organizationId, teamId, collectionId, excludeId } = data;
  const conditions = [
    eq(fieldDefinitions.organizationId, organizationId),
    eq(fieldDefinitions.collectionId, collectionId),
    eq(fieldDefinitions.enabled, true),
    teamId === null
      ? isNull(fieldDefinitions.teamId)
      : eq(fieldDefinitions.teamId, teamId),
  ];
  if (excludeId) {
    conditions.push(ne(fieldDefinitions.id, excludeId));
  }
  const rows = await db
    .select({ id: fieldDefinitions.id })
    .from(fieldDefinitions)
    .where(and(...conditions));
  return rows.length;
};

/**
 * The enabled-field cap for a collection: the `document_record` system type
 * keeps the tight pre-extract budget, every other type gets the larger cap.
 */
const enabledCapForType = async (collectionId: string): Promise<number> => {
  const [row] = await db
    .select({ key: collections.key })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  return row?.key === "document_record"
    ? FIELD_DEFINITION_LIMITS.MAX_ENABLED_PER_SCOPE
    : FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE;
};

/**
 * Assert the type is below its enabled-field cap. Pass `addEnabled=1` when
 * inserting a new enabled row, `0` when updating an existing one.
 */
export const assertScopeEnabledCap = async (data: {
  organizationId: string;
  teamId: string | null;
  collectionId: string;
  addEnabled: number;
  excludeId?: string;
}): Promise<void> => {
  const [current, cap] = await Promise.all([
    countEnabledForScope({
      organizationId: data.organizationId,
      teamId: data.teamId,
      collectionId: data.collectionId,
      excludeId: data.excludeId,
    }),
    enabledCapForType(data.collectionId),
  ]);
  if (current + data.addEnabled > cap) {
    return throwHttpError(
      400,
      badRequest(
        `Cannot exceed ${cap} enabled fields on this type (current: ${current}).`,
      ),
    );
  }
};
