import { z } from "zod";
import {
  fieldDefinitionResourceTypeEnum,
  fieldDefinitionTypeEnum,
} from "../db/schema";
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

export const fieldDefinitionResourceTypeSchema = z.enum(
  fieldDefinitionResourceTypeEnum.enumValues,
);

export const fieldOptionSchema = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  color: z.string().max(20).optional(),
  icon: z.string().max(120).optional(),
});

export const fieldConfigSchema = z.object({
  options: z
    .array(fieldOptionSchema)
    .max(FIELD_DEFINITION_LIMITS.MAX_OPTIONS_PER_FIELD)
    .optional(),
  multiline: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  freeform: z.boolean().optional(),
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
  resourceType: fieldDefinitionResourceTypeSchema,
  key: fieldDefinitionKeySchema,
  label: z.string(),
  description: z.string().nullable(),
  type: fieldDefinitionTypeSchema,
  config: fieldConfigSchema,
  aiExtractionEnabled: z.boolean(),
  vectorizeInclude: z.boolean(),
  displayInPanel: z.boolean(),
  displayInFilters: z.boolean(),
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
 * a weaker AI extraction hint. The LLM-driven suggest flow has its OWN
 * schema (`aiSuggestCreatePayloadSchema`) that requires description.
 *
 * For `select` / `multi_select` types, `config.options` must be
 * non-empty regardless of caller — an enum field without enum values
 * is a broken field. Enforced via `.superRefine`.
 */
export const createFieldDefinitionRequestSchema = z
  .object({
    scope: z.enum(["organization", "team"]),
    resourceType: fieldDefinitionResourceTypeSchema.default("document"),
    key: fieldDefinitionKeySchema,
    label: z.string().min(1).max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS),
    description: z
      .string()
      .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
      .nullish(),
    type: fieldDefinitionTypeSchema,
    config: fieldConfigSchema.default({}),
    aiExtractionEnabled: z.boolean().default(true),
    vectorizeInclude: z.boolean().default(true),
    displayInPanel: z.boolean().default(true),
    displayInFilters: z.boolean().default(false),
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
    aiExtractionEnabled: z.boolean().optional(),
    vectorizeInclude: z.boolean().optional(),
    displayInPanel: z.boolean().optional(),
    displayInFilters: z.boolean().optional(),
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
    .max(FIELD_DEFINITION_LIMITS.MAX_ENABLED_PER_SCOPE),
});

export const applyTemplateRequestSchema = z.object({
  templateKey: z.string().min(1),
  scope: z.enum(["organization", "team"]),
  mode: z.enum(["replace", "merge"]).default("replace"),
});

// ============================================================================
// AI suggest (LLM-backed proposal endpoint)
// ============================================================================

/**
 * Schemas below are designed for **strict JSON Schema delivery to the LLM**.
 *
 * Two practical lessons drove this shape:
 *   1. Vercel AI SDK's `Output.object({ schema })` serialises the Zod
 *      schema and sends it as `response_format: { type: "json_schema",
 *      strict: true }`. The serialised JSON Schema preserves Zod's
 *      `.describe()` strings as `description` properties on each field
 *      — and those descriptions are visible to the model during
 *      structured generation. Plain field names are not enough: the
 *      model needs a one-line semantic gloss per field to avoid
 *      conflating `key` with `description` (which happened repeatedly
 *      with small models like deepseek-v4-flash).
 *   2. Many providers' strict mode rejects schemas containing `default`
 *      values. We therefore drop ALL `.default(...)` calls from the
 *      AI-suggest path — the LLM must produce every field — and the
 *      service layer post-processes any optional flags it cares about.
 */
const aiSuggestFieldOptionSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "Stable machine value (lowercase, snake_case or short code) stored on the document. Lowercase a-z, digits, underscores. Example: 'sea', 'invoice', 'bill_of_lading'.",
    ),
  label: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Human-readable label shown to the user for this option. Example: 'Sea', 'Invoice', 'Bill of Lading'.",
    ),
});

const aiSuggestFieldConfigSchema = z
  .object({
    options: z
      .array(aiSuggestFieldOptionSchema)
      .max(FIELD_DEFINITION_LIMITS.MAX_OPTIONS_PER_FIELD)
      .describe(
        "MANDATORY for type='select' and type='multi_select'. List EVERY legal value — never a sample. Max 50 entries. Omit this property for non-enum types (text, number, date, boolean, url, email).",
      )
      .optional(),
  })
  .describe(
    "Per-field configuration. Only set `options` here, and only for select / multi_select.",
  );

const baseSuggestCreateShape = z.object({
  label: z
    .string()
    .min(1)
    .max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS)
    .describe(
      "Short, human-readable name shown in the document panel and as the filter placeholder. 1-5 words. Example: 'Incoterm', 'Vessel name', 'Customs value'.",
    ),
  description: z
    .string()
    .min(1)
    .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
    .describe(
      "Extraction instruction shipped to the document-parsing LLM that processes every uploaded file. Briefing-style: WHERE on the document the value typically appears (header, footer, named section, label next to it), HOW to format the output (case, units, format), and what to do if absent. Do NOT phrase as a UI tooltip ('Add a field…', 'This field stores…').",
    ),
  type: fieldDefinitionTypeSchema.describe(
    "Value type. 'text' for free-form strings, 'number' for numeric values, 'date' for a calendar date with no time (YYYY-MM-DD), 'datetime' for a date+time stamp (ISO 8601), 'boolean' for yes/no, 'select' for a single value from a closed list, 'multi_select' for several values from a closed list, 'url' / 'email' for the corresponding formats.",
  ),
  config: aiSuggestFieldConfigSchema,
  aiExtractionEnabled: z
    .boolean()
    .describe(
      "Whether the document-parsing LLM should try to populate this field on every upload. true for fields the AI should extract; false for fields the user fills in manually (e.g. an internal label or status).",
    ),
  vectorizeInclude: z
    .boolean()
    .describe(
      "Whether the field's value is added to the chatbot's semantic search index. true for fields users may search by in chat; false for sensitive or internal-only values.",
    ),
  displayInPanel: z
    .boolean()
    .describe(
      "Whether the field is shown on the right-hand document detail panel. Almost always true.",
    ),
  displayInFilters: z
    .boolean()
    .describe(
      "Whether the field appears as a filter in the drive search bar. Usually true for select / multi_select / boolean / date fields the user will want to slice by.",
    ),
  enabled: z
    .boolean()
    .describe(
      "Soft-disable switch. Set to true on creation; only ever set false when the user explicitly asks to disable a field without deleting it.",
    ),
  displayOrder: z
    .number()
    .int()
    .min(0)
    .describe(
      "Position of the field in the panel (lower = higher). Start at the end of the current list unless the user asks for a specific position.",
    ),
});

export const aiSuggestCreatePayloadSchema = baseSuggestCreateShape.superRefine(
  (data, ctx) => {
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
  },
);

export type AiSuggestCreatePayload = z.infer<
  typeof aiSuggestCreatePayloadSchema
>;

/**
 * Patch shape inside the suggest `update` operation. Mirrors the
 * canonical API update schema (every field optional, same constraints)
 * with per-field `.describe()` so the model knows which field carries
 * which intent and which it MUST omit when changing the key (use
 * `rename_key` instead).
 */
const aiSuggestUpdatePatchSchema = z
  .object({
    key: fieldDefinitionKeySchema
      .describe(
        "Do NOT set this. To change a field's key, emit a `rename_key` operation instead. Present here only so the schema mirrors the canonical update shape.",
      )
      .optional(),
    label: z
      .string()
      .min(1)
      .max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS)
      .describe("New label, if the user wants it changed. Omit otherwise.")
      .optional(),
    description: z
      .string()
      .min(1)
      .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
      .describe(
        "Replacement extraction instruction (same writing style as for create). Omit if unchanged.",
      )
      .optional(),
    type: fieldDefinitionTypeSchema
      .describe(
        "Only set if the user explicitly asks to change a field's type. Type changes drop existing values unless `cascade` is true.",
      )
      .optional(),
    config: aiSuggestFieldConfigSchema.optional(),
    aiExtractionEnabled: z.boolean().optional(),
    vectorizeInclude: z.boolean().optional(),
    displayInPanel: z.boolean().optional(),
    displayInFilters: z.boolean().optional(),
    enabled: z.boolean().optional(),
    displayOrder: z.number().int().min(0).optional(),
    cascade: z
      .boolean()
      .describe(
        "Set to true ONLY when changing `type` and the user accepts dropping existing values for the field. Default false.",
      )
      .optional(),
  })
  .describe(
    "Partial update. Include ONLY the keys the user wants changed; omit the rest.",
  );

/**
 * Single proposal operation. Strict shapes per action so the schema
 * delivered to the model unambiguously expresses which fields each
 * action carries.
 */
export const fieldDefinitionOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z
      .literal("create")
      .describe("Add a brand-new field to the current scope."),
    payload: aiSuggestCreatePayloadSchema.describe(
      "Full definition of the new field.",
    ),
  }),
  z.object({
    action: z
      .literal("update")
      .describe(
        "Patch one existing field. Use this for label/description/options/flags changes. NEVER change the key here — use rename_key for that.",
      ),
    id: z
      .uuid()
      .describe(
        "UUID of the existing field to update — MUST come from the provided current state.",
      ),
    patch: aiSuggestUpdatePatchSchema,
  }),
  z.object({
    action: z.literal("delete").describe("Remove an existing field."),
    id: z
      .uuid()
      .describe(
        "UUID of the field to remove — MUST come from the provided current state.",
      ),
    cascade: z
      .boolean()
      .describe(
        "Whether to also drop existing per-document values for this field. Typically true; false only when the user explicitly wants to keep historical values.",
      ),
  }),
  z.object({
    action: z
      .literal("rename_key")
      .describe(
        "Change the stable key of a field while preserving its existing values.",
      ),
    id: z
      .uuid()
      .describe(
        "UUID of the field to rename — MUST come from the provided current state.",
      ),
    newKey: fieldDefinitionKeySchema.describe(
      "New snake_case slug. Same constraints as a fresh key (lowercase, digits, underscores, ≤ 60 chars).",
    ),
  }),
]);

export type FieldDefinitionOperation = z.infer<
  typeof fieldDefinitionOperationSchema
>;

export const aiSuggestRequestSchema = z.object({
  scope: z.enum(["organization", "team"]),
  userPrompt: z.string().min(1).max(4000),
});

export const aiSuggestResponseSchema = z.object({
  operations: z
    .array(fieldDefinitionOperationSchema)
    .max(20)
    .describe(
      "Ordered list of operations to apply. Each entry has an `action` discriminator (create / update / delete / rename_key) and the per-action fields documented on each variant. Keep the list minimal — only the operations that realise the user's intent. Max 20.",
    ),
  summary: z
    .string()
    .min(1)
    .max(800)
    .describe(
      "One-paragraph plain-language recap of the changes you are proposing, shown to the user before they confirm. Keep it factual, short, and write it in the same language as the user's request.",
    ),
});

export type AiSuggestResponse = z.infer<typeof aiSuggestResponseSchema>;

export const batchApplyRequestSchema = z.object({
  scope: z.enum(["organization", "team"]),
  operations: z.array(fieldDefinitionOperationSchema).min(1).max(20),
});

export type BatchApplyRequest = z.infer<typeof batchApplyRequestSchema>;

// ============================================================================
// Templates (list-templates response)
// ============================================================================

export const templateFieldPreviewSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  type: fieldDefinitionTypeSchema,
  optionCount: z.number().int(),
});

export const documentFieldTemplateListEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  fieldCount: z.number().int(),
  fields: z.array(templateFieldPreviewSchema),
});

export type DocumentFieldTemplateListEntryResponse = z.infer<
  typeof documentFieldTemplateListEntrySchema
>;
