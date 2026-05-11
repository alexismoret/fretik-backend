import {
  type PreExtractionLlmOutput,
  preExtractionLlmSchema,
} from "@fretik/shared/schemas/pre-extraction";
import { generateText, Output } from "ai";
import {
  PREEXTRACT_MODEL_IDS,
  preextractFallbackModel,
  preextractModel,
} from "../../lib/openrouter";
import { PREEXTRACT_SYSTEM_PROMPT } from "./prompt";

/**
 * Wall-clock cap on a single `generateText` attempt (primary OR fallback).
 *
 * Calibrated for `openai/gpt-oss-120b` with `reasoning.effort: "low"` on
 * our strict schema (20-value `documentType` enum + 45-value
 * `documentTransportType` + nested entities with role/type enums). A
 * typical run is 10-25s; large documents with many entities push
 * through 30s when reasoning tokens expand. Previously 20s — which
 * fired the abort even when OpenRouter had already streamed the
 * complete response, wastefully cascading to the fallback. 60s gives
 * enough headroom that the primary actually succeeds in steady state
 * while still catching genuine stuck provider calls.
 */
const PREEXTRACT_LLM_TIMEOUT_MS = 60_000;

/** Temperature 0 — we want deterministic classification, not creativity. */
const PREEXTRACT_TEMPERATURE = 0;

export interface RunPreextractLlmArgs {
  /** Concatenated markdown assembled by `buildLlmInput` (includes the seen-pages metadata line). */
  prompt: string;
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
 * emit structured logs and fill `preExtractionMetadata`.
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
  const primaryStart = Date.now();
  try {
    const output = await callLlm(args.prompt, "primary");
    return {
      output,
      tier: "primary",
      modelId: PREEXTRACT_MODEL_IDS.primary,
      durationMs: Date.now() - primaryStart,
    };
  } catch (primaryError) {
    const primaryMs = Date.now() - primaryStart;
    console.warn(
      `[pre-extract] primary model (${PREEXTRACT_MODEL_IDS.primary}) failed after ${primaryMs}ms, retrying with fallback (${PREEXTRACT_MODEL_IDS.fallback}) — ${describeError(primaryError)}`,
    );
    const fallbackStart = Date.now();
    try {
      const output = await callLlm(args.prompt, "fallback");
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
  tier: "primary" | "fallback",
): Promise<PreExtractionLlmOutput> => {
  const model = tier === "primary" ? preextractModel : preextractFallbackModel;

  const { output } = await generateText({
    model,
    output: Output.object({ schema: preExtractionLlmSchema }),
    system: PREEXTRACT_SYSTEM_PROMPT,
    prompt,
    temperature: PREEXTRACT_TEMPERATURE,
    abortSignal: AbortSignal.timeout(PREEXTRACT_LLM_TIMEOUT_MS),
  });

  return output;
};
