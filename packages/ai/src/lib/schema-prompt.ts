import { z } from "zod";

/**
 * Convert a Zod schema to a JSON Schema string suitable for embedding in
 * an LLM system prompt. Uses Zod v4's built-in `z.toJSONSchema`. The
 * `unrepresentable: "any"` option lets `z.unknown()` / `z.never()` survive
 * the conversion as `{}` instead of throwing.
 *
 * Pretty-printed with 2-space indent so the model parses it reliably.
 * Descriptions on individual fields (from `.describe()`) survive as JSON
 * Schema `description` properties — the LLM uses them as authoritative
 * extraction guidance.
 *
 * Why we ALSO ship the schema in the prompt (when it already travels via
 * OpenRouter's `response_format: { type: "json_schema", strict: true }`):
 * upstream provider behaviour varies. Some downgrade strict mode to a
 * free-form `json_object` silently, and the model relies on whatever is
 * in the prompt to know the shape. Belt-and-suspenders.
 */
export const zodToPromptSchema = (schema: z.ZodTypeAny): string =>
  JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 2);

/**
 * Common closing instruction for both pre-extract and AI-suggest system
 * prompts. Keep here (single source) so the two endpoints don't drift.
 */
export const SCHEMA_BLOCK_TRAILER =
  "Return a single JSON object matching the schema above EXACTLY. Every field description in the schema is authoritative — respect enums, regex patterns, min/max lengths, and nullability. Output JSON only — no prose, no Markdown fence, no commentary.";
