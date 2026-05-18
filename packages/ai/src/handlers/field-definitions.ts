import {
  type AiSuggestResponse,
  aiSuggestRequestSchema,
  aiSuggestResponseSchema,
  createFieldDefinitionRequestSchema,
  fieldDefinitionResponseSchema,
  updateFieldDefinitionRequestSchema,
} from "@fretik/shared/schemas/field-definitions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { generateText, Output } from "ai";
import { z } from "zod";
import { preextractFallbackModel, preextractModel } from "../lib/openrouter";
import { SCHEMA_BLOCK_TRAILER, zodToPromptSchema } from "../lib/schema-prompt";
import { internalMiddleware } from "../middlewares/internal";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/field-definitions/suggest
 *
 * Receives the user's plain-language description + current field
 * definitions and asks the LLM to propose a coherent set of operations
 * (create / update / delete / rename_key) that turns the current scope
 * into what the user described.
 *
 * Model envelope (swapped vs pre-extract): the *fallback* pre-extract
 * model runs first because empirically it is faster and produces
 * cleaner structured output for this small, schema-driven task. The
 * pre-extract primary (`gpt-oss-120b`) is kept as a backstop.
 *
 * The 30 s timeout is intentionally tight — the suggest call is a
 * synchronous user-facing action on the settings page. Anything longer
 * than ~10 s feels broken; 30 s is the hard ceiling before we surface
 * an error and let the user retry.
 *
 * Constrained at the model level via `Output.object(...)` so the model
 * cannot emit unsupported actions, field types, or excessive payloads.
 */

const SUGGEST_TIMEOUT_MS = 60_000;
const SUGGEST_TEMPERATURE = 0;
/**
 * Hard ceiling on output tokens. A legitimate batch of operations fits
 * well under 2 000 tokens (≤10 ops × ~200 toks). The 4 000 budget gives
 * margin for verbose `description` fields without leaving DeepSeek room
 * to spiral into the empty-character loops we observed in OpenRouter
 * logs (66 k-token runaway truncated only by the 60 s timeout).
 */
const SUGGEST_MAX_OUTPUT_TOKENS = 8_000;

const SuggestRequestSchema = aiSuggestRequestSchema.extend({
  currentDefinitions: z.array(fieldDefinitionResponseSchema),
});

/**
 * Stable behavioural base for the suggest system prompt. The full JSON
 * Schema (derived from `aiSuggestResponseSchema`) is appended at request
 * time via `zodToPromptSchema(...)` together with the shared
 * `SCHEMA_BLOCK_TRAILER`. Per-field semantics therefore live in the
 * schema's `.describe()` annotations; this base only carries cross-field
 * rules and operation-selection heuristics the schema can't express.
 *
 * The schema is static across all calls so the prompt — base + schema —
 * stays prefix-cache-warm on OpenRouter.
 */
const SUGGEST_SYSTEM_PROMPT_BASE = `You configure document field definitions for a multi-tenant SaaS. The user describes in plain language what they want extracted from their documents; you emit a coherent batch of operations that turns the current state into what they asked for.

CROSS-FIELD RULES
=================
• \`label\` is the only user-facing name you choose. Keep it short (1-5 words), in the user's language. The server derives the internal \`key\` from the label automatically — you do NOT need to emit a key.
• \`description\` is the instruction the document-extraction LLM reads on every upload. Write it as an extraction briefing (where to find the value on the document, how to format it, what to do when absent). Never write it as a UI tooltip or as marketing copy.
• For \`select\` and \`multi_select\`, the \`config.options\` list must enumerate EVERY legal value — never a sample or a TODO.
• Operations referencing an existing field MUST use a UUID from the provided current state — never invent ids.

OPERATION SELECTION
===================
• Prefer \`update\` over \`create\` when the user's intent overlaps an existing field.
• Use \`rename_key\` only when the user explicitly wants to change the internal key of an existing field (rare — the key is auto-derived on create and stays stable across label edits).
• Use \`delete\` only when the user explicitly asks to drop a field.
• If the user's request is ambiguous, propose the smallest change set that captures their intent and explain your reasoning in \`summary\`.

The \`summary\` is written in the same language as the user's request.

OUTPUT DISCIPLINE
=================
Emit the JSON object once, then STOP. Do not append whitespace, padding, comments, repeats, or any further characters after the closing brace. Never emit thousands of empty characters or whitespace runs — that breaks downstream parsing.`;

/**
 * Composed at module load — the schema is static so we don't pay the
 * JSON-stringify cost on every request.
 */
const SUGGEST_SYSTEM_PROMPT = `${SUGGEST_SYSTEM_PROMPT_BASE}

<schema>
${zodToPromptSchema(aiSuggestResponseSchema)}
</schema>

${SCHEMA_BLOCK_TRAILER}`;

const fieldDefinitionsRoutes = new OpenAPIHono<HonoInternalAppType>();
fieldDefinitionsRoutes.use("*", internalMiddleware);

fieldDefinitionsRoutes.post("/suggest", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = SuggestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }

  const { scope, userPrompt, currentDefinitions } = parsed.data;
  const userMessage = [
    `Scope: ${scope}`,
    `Current definitions (${currentDefinitions.length}):`,
    JSON.stringify(
      currentDefinitions.map((d) => ({
        id: d.id,
        key: d.key,
        label: d.label,
        type: d.type,
        enabled: d.enabled,
        description: d.description,
        config: d.config,
      })),
      null,
      2,
    ),
    "",
    "User request:",
    userPrompt,
  ].join("\n");

  try {
    const output = await callSuggest(userMessage, "primary");
    return c.json(output, 200);
  } catch (primaryError) {
    console.warn(
      `[field-definitions/suggest] primary failed: ${primaryError instanceof Error ? primaryError.message : primaryError}`,
    );
    try {
      const output = await callSuggest(userMessage, "fallback");
      return c.json(output, 200);
    } catch (fallbackError) {
      const message =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      console.error(`[field-definitions/suggest] fallback failed: ${message}`);
      return c.json({ code: "AI_SUGGEST_ERROR", message }, 500);
    }
  }
});

const callSuggest = async (
  userMessage: string,
  tier: "primary" | "fallback",
): Promise<AiSuggestResponse> => {
  const model = tier === "primary" ? preextractModel : preextractFallbackModel;
  const { output } = await generateText({
    model,
    output: Output.object({ schema: aiSuggestResponseSchema }),
    system: SUGGEST_SYSTEM_PROMPT,
    prompt: userMessage,
    temperature: SUGGEST_TEMPERATURE,
    maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
  });
  return output;
};

// Reference the create/update schemas so the suggest schema's reliance on
// them stays explicit in the bundle (and tree-shaking doesn't drop the
// underlying type information consumed by clients).
void createFieldDefinitionRequestSchema;
void updateFieldDefinitionRequestSchema;

export { fieldDefinitionsRoutes };
