import type { FieldDefinition } from "@fretik/shared/db/schema";
import { buildPreExtractSchema } from "@fretik/shared/schemas/pre-extraction";
import { generateText, type LanguageModel, Output } from "ai";
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
 * generateText schema-validation failure, abort/timeout. If the
 * fallback itself fails, the error propagates.
 */
/**
 * Serialises a thrown value to a structured diagnostic summary. Captures
 * the constructor name, message, `cause` chain (the AI SDK wraps the
 * inner provider error in it), and optional provider-specific fields
 * (`responseBody`, `statusCode`, `url`) so logs distinguish a
 * client-side AbortSignal timeout from a Zod parse failure from a
 * provider 5xx without guessing.
 *
 * We slice `responseBody` to 800 chars — enough to see the JSON that
 * failed parsing, capped so a 30-page error dump doesn't swamp logs.
 */
const describeError = (err: unknown): string => {
  if (!(err instanceof Error)) return `(non-Error) ${String(err)}`;
  const parts: string[] = [
    `name=${err.name}`,
    `message=${err.message.slice(0, 3000)}`,
  ];
  if (err.cause) {
    if (err.cause instanceof Error) {
      parts.push(
        `cause.name=${err.cause.name}`,
        `cause.message=${err.cause.message.slice(0, 3000)}`,
      );
    } else {
      // Cause is not an Error — JSON-stringify unconditionally so we
      // never hit the `[object Object]` default toString that would
      // make the log useless. `JSON.stringify` tolerates primitives,
      // arrays, and plain objects; returns `undefined` on BigInt /
      // circular refs which we coalesce to an empty marker.
      const raw = JSON.stringify(err.cause) ?? "(uncoercible)";
      parts.push(`cause=${raw.slice(0, 3000)}`);
    }
  }
  const extra = err as unknown as Record<string, unknown>;
  if (typeof extra.statusCode === "number") {
    parts.push(`status=${extra.statusCode}`);
  }
  if (typeof extra.url === "string") {
    parts.push(`url=${extra.url}`);
  }
  if (typeof extra.responseBody === "string") {
    const body = extra.responseBody;
    parts.push(
      `responseBody=${body.slice(0, 3000)}${body.length > 3000 ? "…" : ""}`,
    );
  }
  // Zod validation failures on `generateText` attach the parsed value
  // that failed. Pull it out explicitly so we see the full rejected
  // object (truncated by the slice above), not just a fragment.
  if ("value" in extra && extra.value !== undefined) {
    const valueStr =
      typeof extra.value === "string"
        ? extra.value
        : JSON.stringify(extra.value);
    parts.push(
      `value=${valueStr.slice(0, 3000)}${valueStr.length > 3000 ? "…" : ""}`,
    );
  }
  return parts.join(" | ");
};

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
      `[pre-extract] primary model (${primaryModelId}) failed after ${primaryMs}ms, retrying with fallback (${PREEXTRACT_MODEL_IDS.fallback}) — ${describeError(primaryError)}`,
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
        `[pre-extract] fallback model (${PREEXTRACT_MODEL_IDS.fallback}) also failed after ${fallbackMs}ms — ${describeError(fallbackError)}`,
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
  // Belt-and-suspenders: ship the schema both via `response_format` (the
  // `Output.object` argument) AND inside the system prompt. Some upstream
  // OpenRouter providers silently downgrade strict json_schema mode to
  // free-form `json_object`; when that happens the model relies on the
  // schema in the prompt to know the expected shape.
  const system = `${PREEXTRACT_SYSTEM_PROMPT_BASE}

<schema>
${zodToPromptSchema(schema)}
</schema>

${SCHEMA_BLOCK_TRAILER}`;

  const { output } = await generateText({
    model,
    output: Output.object({ schema }),
    system,
    prompt,
    temperature: PREEXTRACT_TEMPERATURE,
    maxOutputTokens: PREEXTRACT_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(PREEXTRACT_LLM_TIMEOUT_MS),
    telemetry: telemetryFor("pre-extract"),
  });

  return output;
};
