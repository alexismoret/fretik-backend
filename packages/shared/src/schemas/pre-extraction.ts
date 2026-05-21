import { z } from "zod";
import {
  entityRoleEnum,
  entityTypeEnum,
  type FieldDefinition,
} from "../db/schema";

/**
 * Entity extracted from a document by the LLM. Multiple entries with the
 * same `name` but different `role` are expected when an organisation plays
 * several roles in the same document (e.g. issuer + consignee).
 */
export const preExtractionEntitySchema = z.object({
  name: z
    .string()
    .max(200)
    .describe(
      "Exact company/organization name as written on the document (do not normalise casing or expand acronyms).",
    ),
  role: z
    .enum(entityRoleEnum.enumValues)
    .describe(
      "Role of the entity in the document context. issuer = the organisation that issued/created the document; customer = the customer/client/buyer/recipient party; broker = intermediary agent acting between two other parties (e.g. freight forwarder, customs broker, sales agent); consignee = party receiving goods or services (only if distinct from customer); shipper = party sending goods or services (only if distinct from issuer); mentioned = any other organisation mentioned that does not fit the above.",
    ),
  type: z
    .enum(entityTypeEnum.enumValues)
    .optional()
    .describe(
      "Entity category. client = end customers / buyers / recipients; carrier = transportation operator (used only when a team's domain is transport/logistics — leave empty otherwise); other = anything else (government bodies, certification authorities, banks, insurance companies, generic vendors, partners, …).",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Confidence level (0..1) in the accuracy of this specific entity/role extraction.",
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
      "ALL organisations/companies mentioned in the document. Do NOT limit the number of entities. If the SAME organisation plays SEVERAL roles in the document (e.g. the same company is both ISSUER and CONSIGNEE), emit ONE entry PER role (same `name`, different `role`, with the appropriate `confidence` for each) — do NOT pick a single 'best' role.",
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
 * description; Vercel AI SDK's `Output.object` forwards it to the JSON
 * Schema sent to the LLM, so the model knows precisely what to extract
 * without us having to grow the system prompt.
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
    shape[def.key] = zodForField(def);
  }
  return shape;
};

const zodForField = (def: FieldDefinition): z.ZodTypeAny => {
  const description = def.description ?? def.label;
  switch (def.type) {
    case "text":
    case "url":
    case "email": {
      return z.string().nullish().describe(description);
    }
    case "number": {
      return z.number().nullish().describe(description);
    }
    case "boolean": {
      return z.boolean().nullish().describe(description);
    }
    case "date": {
      return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
        .nullish()
        .describe(
          `${description} Format: YYYY-MM-DD (calendar date only, no time component).`,
        );
    }
    case "datetime": {
      return z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,
          "Expected ISO 8601 datetime",
        )
        .nullish()
        .describe(
          `${description} Format: ISO 8601 datetime (e.g. 2025-01-15T10:30:00Z).`,
        );
    }
    case "select": {
      const values = optionValues(def);
      if (values.length === 0)
        return z.string().nullish().describe(description);
      return z
        .enum(values as [string, ...string[]])
        .nullish()
        .describe(description);
    }
    case "multi_select": {
      const values = optionValues(def);
      if (values.length === 0) {
        return z.array(z.string()).nullish().describe(description);
      }
      return z
        .array(z.enum(values as [string, ...string[]]))
        .nullish()
        .describe(description);
    }
  }
};

const optionValues = (def: FieldDefinition): string[] => {
  const options = def.config?.options;
  if (!options) return [];
  return options.map((o) => o.value);
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
   * (JSON primitives or arrays) — the persistence layer just hands them
   * to the JSONB column on `document_field_values`.
   */
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export type PreExtractionResponse = z.infer<typeof preExtractionResponseSchema>;
