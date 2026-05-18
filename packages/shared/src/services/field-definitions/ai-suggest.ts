import type { FieldDefinition } from "../../db/schema";
import { callAiService, type AiServiceContext } from "../../lib/ai-service";
import {
  aiSuggestResponseSchema,
  type AiSuggestResponse,
} from "../../schemas/field-definitions";

/**
 * Request the GPT-OSS-120B-backed AI to propose a set of operations
 * (create/update/delete/rename_key) that turn the current scope into what
 * the user described in plain language.
 *
 * The actual LLM call lives in `@fretik/ai/src/handlers/field-definitions.ts`
 * (internal route) so we get OpenRouter access + cache + fallback model
 * for free. The shared layer only wraps the HTTP call and parses the
 * response; nothing here should know about provider specifics.
 *
 * Limits checked again on the AI side (max 15 enabled post-application,
 * max 50 options, label/description lengths) — the LLM is constrained by
 * the Zod schema sent via `Output.object`, but we re-validate before
 * surfacing the operations to the user.
 */
export const suggestFieldDefinitionChanges = async (data: {
  scope: "organization" | "team";
  userPrompt: string;
  currentDefinitions: FieldDefinition[];
  ctx: AiServiceContext;
}): Promise<AiSuggestResponse> => {
  return await callAiService(
    "/internal/field-definitions/suggest",
    {
      scope: data.scope,
      userPrompt: data.userPrompt,
      currentDefinitions: data.currentDefinitions,
    },
    aiSuggestResponseSchema,
    data.ctx,
    { timeoutMs: 60_000 },
  );
};
