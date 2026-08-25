import { z } from "zod";
import { fieldDefinitionTypeEnum } from "../db/schema";
import {
  BARCODE_FORMATS,
  FORMULA_RESULT_TYPES,
} from "../db/schema/field-types";
import {
  FIELD_DEFINITION_KEY_REGEX,
  FIELD_DEFINITION_LIMITS,
  FORMULA_LIMITS,
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
  color: z.string().max(20).optional(),
  showNumber: z.boolean().optional(),
  // How the value renders: itself, a progress meter (number only), or a
  // scannable code (text / number / unique_id / formula; url / phone / email
  // take `qr` only). Which values a given type accepts is enforced by
  // `validateFieldDefinitionShape` — this superset is flat like the rest.
  display: z.enum(["plain", "bar", "ring", "qr", "barcode"]).optional(),
  barcodeFormat: z.enum(BARCODE_FORMATS).optional(),
  // relation
  targetCollectionKey: z.string().max(60).optional(),
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
  // formula (a read-only column the database computes from this record's own
  // fields). `resultType` is INFERRED by the compiler at save — accepted here
  // only so a config can round-trip; whatever a caller sends is overwritten.
  expression: z.string().max(FORMULA_LIMITS.MAX_EXPRESSION_CHARS).optional(),
  resultType: z.enum(FORMULA_RESULT_TYPES).optional(),
  currencyCode: z.string().max(3).optional(),
});

/**
 * Dry-run a formula without saving. `ok: false` is a 200: an expression that
 * does not compile is the normal state while someone is typing one, and the
 * editor needs the message and the position to point at it.
 */
export const checkFormulaRequestSchema = z.object({
  collectionId: z.uuid(),
  expression: z.string().max(FORMULA_LIMITS.MAX_EXPRESSION_CHARS),
  /** The field being edited, so its own previous version is not in scope. */
  fieldId: z.uuid().optional(),
});

/**
 * The parsed tree, so the visual builder can open an existing formula. Typed
 * loosely on the wire (`z.unknown()` for the recursive parts) because the shape
 * is defined by the compiler, not by this schema — restating a recursive union
 * here would be a second definition free to disagree with the parser's.
 */
const formulaAstSchema = z.looseObject({ kind: z.string() });

export const checkFormulaResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    resultType: z.enum(FORMULA_RESULT_TYPES),
    dependsOn: z.array(z.string()),
    ast: formulaAstSchema,
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    /** 0-based character offset in the expression. */
    at: z.number().int(),
  }),
]);

/** The function palette the visual builder draws from. Static per deploy. */
export const formulaFunctionsResponseSchema = z.object({
  functions: z.array(
    z.object({
      name: z.string(),
      hint: z.string(),
      variadic: z.boolean(),
      minArgs: z.number().int(),
      params: z.array(z.object({ name: z.string(), type: z.string() })),
    }),
  ),
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
  collectionId: z.uuid(),
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
  // Index bookkeeping, carried so this schema still describes the whole row —
  // `/internal/pre-extract` ships stored field definitions over HTTP and types
  // them from here. Defaulted, so no caller has to send them.
  indexUnusedSince: z.coerce.date().nullable().default(null),
  indexDroppedAt: z.coerce.date().nullable().default(null),
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
    // The collection the field attaches to. Resolve by id when known,
    // otherwise by key (the handler defaults to the document_record system type).
    collectionId: z.uuid().optional(),
    collectionKey: z.string().optional(),
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
