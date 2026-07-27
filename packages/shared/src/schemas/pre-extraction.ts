import { z } from "zod";
import { type FieldDefinition } from "../db/schema";
import { zodForField } from "./record-shape";

/**
 * Organisation/company extracted from a document by the LLM, by name. The
 * pipeline resolves each to a `company` record and links it to the document via
 * the generic `mentions` relation. No role/type classification — that was
 * transport-domain heritage; the generic core only records who is mentioned.
 */
export const preExtractionEntitySchema = z.object({
  name: z
    .string()
    .max(200)
    .describe(
      "Exact company/organization name as written on the document (do not normalise casing or expand acronyms).",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Confidence level (0..1) in the accuracy of this specific entity extraction.",
    ),
});

/**
 * Universal shape produced by the pre-extract LLM on every document,
 * regardless of the active team's field definitions. The `customFields`
 * shape is built at runtime by `buildPreExtractCustomShape(defs)` and
 * spliced into the parent schema by `buildPreExtractSchema(defs)`.
 */
const preExtractionUniversalSchema = z.object({
  documentSummary: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "Factual summary of the document purpose and key information. Aim for 3-5 sentences. Target under 500 characters; 1000 is a hard cap.",
    ),
  documentLanguage: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .toLowerCase()
    .describe(
      "Primary language of the document content as an ISO 639-1 two-letter code, lowercase (e.g. en, fr, de, es, it, nl, pt). MUST be exactly 2 characters.",
    ),
  entities: z
    .array(preExtractionEntitySchema)
    .default([])
    .describe(
      "ALL organisations/companies mentioned in the document, by name. Do NOT limit the number. List each distinct organisation once.",
    ),
  confidenceScore: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .describe(
      "Overall confidence (0..1) in the extraction quality across all fields. Null if not self-assessable.",
    ),
});

export type PreExtractionUniversalOutput = z.infer<
  typeof preExtractionUniversalSchema
>;

/**
 * Build a Zod object whose shape mirrors the active team's field
 * definitions. The `.describe()` on each field carries the user-facing
 * description; `zodToPromptSchema` serialises it into the JSON Schema
 * block of the pre-extract system prompt, so the model knows precisely
 * what to extract without us having to grow the base prompt.
 *
 * Type mapping:
 *   - text / url / email → z.string()
 *   - number             → z.number()
 *   - date               → z.string() ISO 8601 (coerced to Date at the
 *                          response boundary in `preExtractionResponseSchema`)
 *   - boolean            → z.boolean()
 *   - select             → z.enum(values) when options exist, else string
 *   - multi_select       → z.array(z.enum(values)) when options exist,
 *                          z.array(z.string()) otherwise
 *
 * All custom fields are `.nullish()` so the LLM is free to skip ones that
 * are not present on the document.
 */
export const buildPreExtractCustomShape = (
  definitions: FieldDefinition[],
): Record<string, z.ZodTypeAny> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of definitions) {
    if (!def.aiExtractionEnabled || !def.enabled) continue;
    // Relations live in the `links` graph, not `data` — never extracted here.
    if (def.type === "relation") continue;
    shape[def.key] = zodForField(def);
  }
  return shape;
};

/**
 * Compose the full pre-extract LLM schema (universal + custom) for a
 * team's field definitions. Built once per pre-extract call.
 */
export const buildPreExtractSchema = (definitions: FieldDefinition[]) => {
  return preExtractionUniversalSchema.extend({
    customFields: z
      .object(buildPreExtractCustomShape(definitions))
      .describe(
        "Domain-specific fields extracted per the team's configuration. Each key matches one configured field; values follow its declared type.",
      ),
  });
};

export type PreExtractionLlmOutput = z.infer<
  typeof preExtractionUniversalSchema
> & {
  customFields: Record<string, unknown>;
};

/**
 * Full HTTP response shape of `POST /internal/pre-extract` (@fretik/ai).
 * Extends the LLM shape with the three orchestrator-filled fields
 * (`success`, `pages`, `pageCount`) that are NOT produced by the model.
 * Consumed by `@fretik/shared/services/documents/upload.ts`.
 */
export const preExtractionResponseSchema = z.object({
  success: z.boolean(),
  pages: z.array(
    z.object({
      index: z.number(),
      markdown: z.string(),
    }),
  ),
  pageCount: z.number(),
  documentSummary: z.string(),
  documentLanguage: z.string().nullable(),
  entities: z.array(preExtractionEntitySchema).default([]),
  confidenceScore: z.number().nullish(),
  /**
   * Custom field values keyed by `fieldDefinitions.key`. Stored as-is
   * (JSON primitives or arrays) — the pipeline writes them to the `data` JSONB
   * of the document's mirror object-record.
   */
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export type PreExtractionResponse = z.infer<typeof preExtractionResponseSchema>;
