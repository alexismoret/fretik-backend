import { z } from "zod";
import { fieldDefinitionTypeEnum } from "../db/schema";
import {
  FIELD_DEFINITION_KEY_REGEX,
  FIELD_DEFINITION_LIMITS,
} from "../services/field-definitions/constants";

// ============================================================================
// Building blocks
// ============================================================================

export const fieldDefinitionTypeSchema = z.enum(
  fieldDefinitionTypeEnum.enumValues,
);

export const fieldOptionSchema = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  color: z.string().max(20).optional(),
  icon: z.string().max(120).optional(),
  // Status semantics (kanban lanes) — see `FieldDefinitionOption.group`.
  group: z.enum(["todo", "in_progress", "done"]).optional(),
});

/**
 * Permissive superset of every per-type config (mirrors `FieldTypeConfigMap` in
 * `db/schema/field-types.ts`). Kept flat at the API boundary — per-type
 * correctness is enforced by `validateFieldDefinitionShape` and the relation
 * binding in the service layer. Keep this in sync when adding a field type.
 */
export const fieldConfigSchema = z.object({
  // select / multi_select
  options: z
    .array(fieldOptionSchema)
    .max(FIELD_DEFINITION_LIMITS.MAX_OPTIONS_PER_FIELD)
    .optional(),
  freeform: z.boolean().optional(),
  // text
  multiline: z.boolean().optional(),
  // date (single type; time-of-day is opt-in, Notion-style)
  hasTime: z.boolean().optional(),
  // number (+ "Progress" display)
  min: z.number().optional(),
  max: z.number().optional(),
  numberFormat: z.enum(["plain", "commas", "percent"]).optional(),
  precision: z.number().int().min(0).max(10).optional(),
  suffix: z.string().max(8).optional(),
  display: z.enum(["plain", "bar", "ring"]).optional(),
  color: z.string().max(20).optional(),
  showNumber: z.boolean().optional(),
  // relation
  targetTypeKey: z.string().max(60).optional(),
  cardinality: z.enum(["one", "many"]).optional(),
  linkTypeKey: z.string().max(60).optional(),
  widget: z.literal("attachment").optional(),
  // member
  multiple: z.boolean().optional(),
  // money
  defaultCurrencyCode: z.string().max(3).optional(),
  // rating
  ratingMax: z.number().int().min(1).max(20).optional(),
  ratingIcon: z.string().max(120).optional(),
  // unique_id (auto reference like "TASK-42")
  prefix: z.string().max(12).optional(),
  // rollup (read-only aggregate over a relation field)
  relationFieldKey: z.string().max(60).optional(),
  targetFieldKey: z.string().max(60).optional(),
  fn: z
    .enum([
      "sum",
      "count",
      "avg",
      "min",
      "max",
      "count_not_empty",
      "percent_not_empty",
      "percent_checked",
    ])
    .optional(),
});

export const fieldDefinitionKeySchema = z
  .string()
  .min(1)
  .max(60)
  .regex(FIELD_DEFINITION_KEY_REGEX);

// ============================================================================
// Response shapes (from the API)
// ============================================================================

export const fieldDefinitionResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid().nullable(),
  objectTypeId: z.uuid(),
  key: fieldDefinitionKeySchema,
  label: z.string(),
  description: z.string().nullable(),
  type: fieldDefinitionTypeSchema,
  config: fieldConfigSchema,
  aiExtractionEnabled: z.boolean(),
  vectorizeInclude: z.boolean(),
  displayInPanel: z.boolean(),
  isTitle: z.boolean(),
  enabled: z.boolean(),
  displayOrder: z.number().int(),
  // `z.coerce.date()` (not `z.date()`) so the schema accepts BOTH `Date`
  // instances (in-process callers) AND ISO strings (HTTP payloads from
  // @fretik/api → /internal/pre-extract + /internal/field-definitions/suggest
  // serialise Date columns to strings on the wire).
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FieldDefinitionResponse = z.infer<
  typeof fieldDefinitionResponseSchema
>;

// ============================================================================
// Create / Update / Reorder request payloads
// ============================================================================

/**
 * Manual-create payload (settings UI). Humans can skip the description
 * — when the key is self-explanatory the field still works, just with
 * a weaker AI extraction hint.
 *
 * For `select` / `multi_select` types, `config.options` must be
 * non-empty regardless of caller — an enum field without enum values
 * is a broken field. Enforced via `.superRefine`.
 */
export const createFieldDefinitionRequestSchema = z
  .object({
    scope: z.enum(["organization", "team"]),
    // The object type the field attaches to. Resolve by id when known,
    // otherwise by key (the handler defaults to the document_record system type).
    objectTypeId: z.uuid().optional(),
    objectTypeKey: z.string().optional(),
    // Optional: omitted from the UI and derived server-side from the label.
    // Templates / imports may still pass an explicit key.
    key: fieldDefinitionKeySchema.optional(),
    label: z.string().min(1).max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS),
    description: z
      .string()
      .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
      .nullish(),
    type: fieldDefinitionTypeSchema,
    config: fieldConfigSchema.default({}),
    isTitle: z.boolean().optional(),
    aiExtractionEnabled: z.boolean().default(true),
    vectorizeInclude: z.boolean().default(true),
    displayInPanel: z.boolean().default(true),
    enabled: z.boolean().default(true),
    displayOrder: z.number().int().min(0).default(0),
  })
  .superRefine((data, ctx) => {
    if (data.type === "select" || data.type === "multi_select") {
      const opts = data.config?.options ?? [];
      if (opts.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["config", "options"],
          message:
            "Select / multi_select fields require at least one option in config.options.",
        });
      }
    }
  });

export type CreateFieldDefinitionRequest = z.infer<
  typeof createFieldDefinitionRequestSchema
>;

/**
 * Update is a strict patch: every field is optional, but when a field IS
 * provided it must satisfy the same constraints as the create schema.
 *   • `description`: optional and clearable (`null`) — humans may leave
 *     it empty; the AI path won't.
 *   • when the patch flips the type to `select` / `multi_select` AND
 *     replaces `config`, the new options array must be non-empty. The
 *     cross-field rule lives in `superRefine` because Zod can't express
 *     "options required only when type changes to X" purely at the type
 *     level.
 */
export const updateFieldDefinitionRequestSchema = z
  .object({
    key: fieldDefinitionKeySchema.optional(),
    label: z
      .string()
      .min(1)
      .max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS)
      .optional(),
    description: z
      .string()
      .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
      .nullable()
      .optional(),
    type: fieldDefinitionTypeSchema.optional(),
    config: fieldConfigSchema.optional(),
    isTitle: z.boolean().optional(),
    aiExtractionEnabled: z.boolean().optional(),
    vectorizeInclude: z.boolean().optional(),
    displayInPanel: z.boolean().optional(),
    enabled: z.boolean().optional(),
    displayOrder: z.number().int().min(0).optional(),
    cascade: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.type === "select" || data.type === "multi_select") &&
      data.config !== undefined
    ) {
      const opts = data.config.options ?? [];
      if (opts.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["config", "options"],
          message:
            "Select / multi_select fields require at least one option in config.options.",
        });
      }
    }
  });

export type UpdateFieldDefinitionRequest = z.infer<
  typeof updateFieldDefinitionRequestSchema
>;

export const reorderFieldDefinitionsRequestSchema = z.object({
  scope: z.enum(["organization", "team"]),
  ids: z
    .array(z.uuid())
    .min(1)
    .max(FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE),
});
