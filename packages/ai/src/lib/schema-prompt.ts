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
 * The prompt is the ONLY channel the schema reaches the model through:
 * callers generate free-form and validate the parsed output themselves.
 * `response_format` (AI SDK `Output.object`) is deliberately not used —
 * it never reaches the model as input, providers that don't support it
 * drop it silently, and the constrained decoding it activates makes
 * Gemini-class models bail mid-output.
 */
export const zodToPromptSchema = (schema: z.ZodTypeAny): string =>
  JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 2);

/**
 * Common closing instruction for both pre-extract and AI-suggest system
 * prompts. Keep here (single source) so the two endpoints don't drift.
 */
export const SCHEMA_BLOCK_TRAILER =
  "Return a single JSON object matching the schema above EXACTLY. Every field description in the schema is authoritative — respect enums, regex patterns, min/max lengths, and nullability. Output JSON only — no prose, no Markdown fence, no commentary.";
