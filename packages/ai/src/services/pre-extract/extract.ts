import type { FieldDefinition } from "@fretik/shared/db/schema";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { buildPreExtractSchema } from "@fretik/shared/schemas/pre-extraction";
import { generateText, type LanguageModel } from "ai";
import { describeLlmError } from "../../lib/describe-llm-error";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModelForTeam } from "../../lib/model-registry/team-model";
import {
  PREEXTRACT_MODEL_IDS,
  preextractFallbackModel,
} from "../../lib/openrouter";
import {
  SCHEMA_BLOCK_TRAILER,
  zodToPromptSchema,
} from "../../lib/schema-prompt";
import { PREEXTRACT_SYSTEM_PROMPT_BASE } from "./prompt";

/**
 * Output shape returned by the pre-extract LLM, derived from the runtime
 * Zod schema. Universal fields are stable across teams; `customFields`
 * keys are whatever the team's enabled field definitions declared.
 */
export type PreExtractionLlmOutput = {
  documentSummary: string;
  documentLanguage: string;
  entities: {
    name: string;
    confidence?: number;
  }[];
  confidenceScore?: number | null;
  customFields: Record<string, unknown>;
};

/**
 * Wall-clock cap on a single `generateText` attempt (primary OR fallback).
 *
 * The pre-extract schema is now dynamic — universal fields (summary,
 * language, entities) plus the team's custom field defs spliced into
 * `customFields`. Total payload + reasoning budget varies with team
 * configuration, so we keep the ceiling generous (60s) to absorb large
 * teams with many enabled definitions.
 */
const PREEXTRACT_LLM_TIMEOUT_MS = 60_000;

/** Temperature 0 — we want deterministic classification, not creativity. */
const PREEXTRACT_TEMPERATURE = 0;

/**
 * Hard ceiling on output tokens to prevent runaway loops (empty-character
 * spirals observed on DeepSeek). The pre-extract schema is bounded:
 * summary ≤500 chars, ~20 entities × ~80 toks, ≤30 custom fields × ~50
 * toks → ~3 500 toks worst case. The 4 000 budget gives headroom without
 * leaving the model room to drift into multi-thousand-token padding.
 */
const PREEXTRACT_MAX_OUTPUT_TOKENS = 4000;

export interface RunPreextractLlmArgs {
  /** Concatenated markdown assembled by `buildLlmInput` (includes the seen-pages metadata line). */
  prompt: string;
  /**
   * Active team field definitions. Used to build the runtime Zod schema
   * (universal + per-team `customFields`) handed to the LLM. Empty array
   * is valid — the LLM extracts only universal fields.
   */
  fieldDefinitions: FieldDefinition[];
  /**
   * Team whose workhorse pick (C8b) the PRIMARY pre-extract model honours.
   * Undefined falls back to the code default. The fallback tier stays fixed.
   */
  teamId?: string;
}

export interface RunPreextractLlmResult {
  output: PreExtractionLlmOutput;
  /** Which tier actually produced the result. */
  tier: "primary" | "fallback";
  /** Model id (from env) that produced the result — useful for logs. */
  modelId: string;
  /** Wall-clock duration of the successful call, in ms. */
  durationMs: number;
}

/**
 * Calls the pre-extraction LLM with `generateText()` and automatic
 * primary → fallback retry on error. Returns the Zod-parsed output plus
 * diagnostic info (tier, model id, duration) so the orchestrator can
 * emit a structured log line per call.
 *
 * The fallback triggers on ANY failure of the primary: network 5xx,
 * unparsable output, Zod validation failure, abort/timeout. If the
 * fallback itself fails, the error propagates.
 */
export const runPreextractLlm = async (
  args: RunPreextractLlmArgs,
): Promise<RunPreextractLlmResult> => {
  // Build the runtime Zod schema once for the call. Universal fields +
  // dynamic `customFields` shape built from the team's definitions.
  const schema = buildPreExtractSchema(args.fieldDefinitions);

  // Primary honours the team's workhorse pick (C8b); the fallback tier is
  // fixed (code default).
  const primaryResolved = await resolveModelForTeam("pre-extract", args.teamId);
  const primaryModel = primaryResolved.model;
  const primaryModelId = primaryResolved.profile.catalog.id;

  const primaryStart = Date.now();
  try {
    const output = await callLlm(args.prompt, schema, primaryModel);
    return {
      output,
      tier: "primary",
      modelId: primaryModelId,
      durationMs: Date.now() - primaryStart,
    };
  } catch (primaryError) {
    const primaryMs = Date.now() - primaryStart;
    console.warn(
      `[pre-extract] primary model (${primaryModelId}) failed after ${primaryMs}ms, retrying with fallback (${PREEXTRACT_MODEL_IDS.fallback}) — ${describeLlmError(primaryError)}`,
    );
    const fallbackStart = Date.now();
    try {
      const output = await callLlm(
        args.prompt,
        schema,
        preextractFallbackModel,
      );
      return {
        output,
        tier: "fallback",
        modelId: PREEXTRACT_MODEL_IDS.fallback,
        durationMs: Date.now() - fallbackStart,
      };
    } catch (fallbackError) {
      const fallbackMs = Date.now() - fallbackStart;
      console.error(
        `[pre-extract] fallback model (${PREEXTRACT_MODEL_IDS.fallback}) also failed after ${fallbackMs}ms — ${describeLlmError(fallbackError)}`,
      );
      throw fallbackError;
    }
  }
};

const callLlm = async (
  prompt: string,
  schema: ReturnType<typeof buildPreExtractSchema>,
  model: LanguageModel,
): Promise<PreExtractionLlmOutput> => {
  // Free-form generation: the schema travels ONLY inside the system prompt.
  // No `Output.object` — its `response_format: json_schema, strict` never
  // reaches the model as input (the SDK sends it solely as a decoding
  // constraint), providers that don't support it drop it silently, and
  // constrained decoding itself makes Gemini-class models bail mid-output
  // (measured 0/4 constrained vs 7/7 free-form in the extract engine).
  // The lenient shared parse + Zod validation below replace the SDK's
  // brittle strict parse; a failure throws into the primary→fallback tier.
  const system = `${PREEXTRACT_SYSTEM_PROMPT_BASE}

<schema>
${zodToPromptSchema(schema)}
</schema>

${SCHEMA_BLOCK_TRAILER}`;

  const { text } = await generateText({
    model,
    system,
    prompt,
    temperature: PREEXTRACT_TEMPERATURE,
    maxOutputTokens: PREEXTRACT_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(PREEXTRACT_LLM_TIMEOUT_MS),
    telemetry: telemetryFor("pre-extract"),
  });

  const parsed = parseLlmJsonObject(text);
  if (parsed === null) {
    throw new Error(
      `pre-extract: no JSON object found in the model output (${text.length} chars)`,
    );
  }
  return schema.parse(parsed);
};
