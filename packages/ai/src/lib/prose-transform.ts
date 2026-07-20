import { type LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { mapBounded } from "./bounded-map";
import { describeLlmError } from "./describe-llm-error";
import { telemetryFor } from "./langfuse";
import { resolveModel } from "./model-registry/resolve";

/**
 * Prose-transform engine — the `transform` tool's core. Applies one prose
 * instruction to a document's text at document scale, chunk by chunk, and
 * concatenates the results into one transformed document. Sibling of
 * `structured-extract.ts`: same bounded-concurrency + halve-then-fallback
 * shape, but text-in / text-out with NO JSON schema.
 *
 * DELIBERATELY a pure MAP (per-chunk transform → concatenate), so it is
 * correct ONLY for length-preserving transformations where each chunk
 * transforms in isolation: translate, rewrite, restyle, reformat, redact,
 * fix. It is NOT a reduce — summarising/synthesising each chunk and
 * concatenating yields N disjoint mini-summaries, not one coherent whole.
 * The tool description routes those elsewhere; the engine never promises
 * them.
 *
 * It exists to close the gap that produced a 24-python-call prod failure:
 * a model asked to translate a 120K-char FAQ had no first-class path, so
 * it authored the translation inside Python string literals across one
 * doomed turn. `transform` is that path — the heavy text never re-enters
 * the agent's context; the result lands in a `/workspace` file.
 */

const transformPrimary = resolveModel("transform");
const transformFallback = resolveModel("transform-fallback");
const TRANSFORM_MODEL_ID = transformPrimary.profile.catalog.id;
const TRANSFORM_FALLBACK_MODEL_ID = transformFallback.profile.catalog.id;

/**
 * Chars per chunk — deliberately SMALLER than extract's 60K budget.
 * Extract compresses (60K of document in → a small JSON record out);
 * transform is output-PARITY (a translation/rewrite is roughly as long as
 * its input), so a chunk must fit BOTH its input AND its transformed
 * output under the model's caps. 24K chars ≈ 6K input tokens → ≈6-8K
 * output tokens, safely under `TRANSFORM_MAX_OUTPUT_TOKENS`. Raising this
 * (e.g. to extract's 60K) would guarantee a `finishReason: "length"`
 * truncation on nearly every chunk. If the bound profile's output cap
 * changes, revisit this constant.
 */
export const TRANSFORM_CHUNK_CHAR_BUDGET = 24_000;
/** A chunk at/under this size stops halving and spends the fallback model. */
export const TRANSFORM_MIN_CHUNK_CHARS = 6_000;
/** Bounded parallelism across chunk calls (matches extract). */
const TRANSFORM_CHUNK_CONCURRENCY = 2;
const TRANSFORM_TEMPERATURE = 0;
// Headroom over the ~8K output tokens a full 24K-char chunk produces: a
// load-test A/B saw a chunk land at 7978/8000, so dense real prose (regulatory
// text expands more than plain paragraphs) could clip the old 8K cap and force
// a needless halve-retry. Only tokens actually generated are billed, so the
// higher ceiling is free insurance, not a cost.
const TRANSFORM_MAX_OUTPUT_TOKENS = 16_000;
// Per-chunk wall-clock bound. Adequate once the profile routes throughput-first
// (`sort: "throughput"` on deepseek-v4-flash): a 150K-char / 7-chunk load test
// completed every chunk on the first attempt with zero timeouts (298s total,
// down from 496s with two 120s timeouts on the default price-sorted routing).
const TRANSFORM_TIMEOUT_MS = 120_000;

/**
 * Split source text into chunks under the char budget, packing whole
 * paragraph blocks (`\n\n`-separated) greedily. A single block larger than
 * the budget is hard-split into budget-sized slices — a degenerate case
 * (one giant paragraph); most documents are paragraph-structured. Runs of
 * 3+ newlines collapse to one blank line on the boundary, which is
 * lossless for rendered markdown.
 */
export const planProseChunks = (
  text: string,
  charBudget: number = TRANSFORM_CHUNK_CHAR_BUDGET,
): string[] => {
  const budget = Math.max(1, charBudget);
  const blocks = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };
  for (const block of blocks) {
    if (block.length > budget) {
      flush();
      for (let index = 0; index < block.length; index += budget) {
        chunks.push(block.slice(index, index + budget));
      }
      continue;
    }
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (candidate.length > budget) {
      flush();
      current = block;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
};

/**
 * Split a too-large chunk at a paragraph boundary near its midpoint —
 * NEVER mid-sentence, since two independently-transformed halves would not
 * re-join cleanly at the seam. Returns `[chunk]` unchanged when the chunk
 * has no interior paragraph break to split on (→ the caller stops halving
 * and spends the fallback model instead).
 */
const splitChunk = (chunk: string): readonly string[] => {
  const mid = Math.floor(chunk.length / 2);
  const before = chunk.lastIndexOf("\n\n", mid);
  const after = chunk.indexOf("\n\n", mid);
  const cut =
    before >= TRANSFORM_MIN_CHUNK_CHARS ? before : after !== -1 ? after : -1;
  if (cut === -1) return [chunk];
  return [chunk.slice(0, cut), chunk.slice(cut + 2)];
};

const buildTransformSystemPrompt = (instruction: string): string =>
  `You transform text exactly as instructed, and output ONLY the transformed text.

Rules:
- Apply the transformation to the ENTIRE input, faithfully and completely — never summarise, skip, abbreviate, or add content.
- You are given ONE part of a larger document. Transform only what you see; do not add a preamble, a title, or a closing note.
- Preserve the input's structural formatting one-to-one: headings, lists, tables, code blocks, links, emphasis, and blank-line paragraph breaks.
- Copy verbatim anything the instruction does not tell you to change: numbers, dates, code, URLs, proper nouns, identifiers.
- Output ONLY the transformed text — no explanation, no commentary, no wrapping code fences.

Transformation to apply:
${instruction}`;

interface ChunkCallResult {
  text: string;
  truncated: boolean;
}

/** One transform call. Valid-but-capped output is kept and flagged truncated. */
const callTransformLlm = async (
  model: LanguageModelV4,
  chunk: string,
  instruction: string,
): Promise<ChunkCallResult> => {
  const { text, finishReason } = await generateText({
    model,
    system: buildTransformSystemPrompt(instruction),
    temperature: TRANSFORM_TEMPERATURE,
    maxOutputTokens: TRANSFORM_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(TRANSFORM_TIMEOUT_MS),
    // Nests under the `transform` tool call → under the turn trace.
    telemetry: telemetryFor("transform"),
    messages: [{ role: "user", content: [{ type: "text", text: chunk }] }],
  });
  return { text, truncated: finishReason === "length" };
};

export interface ChunkOutcome {
  /** Transformed text — or the ORIGINAL chunk verbatim when both models failed. */
  output: string;
  /** True when the original was passed through (both models failed). */
  failed: boolean;
  /** True when a chunk hit the output cap and may be incomplete. */
  truncated: boolean;
  usedFallback: boolean;
}

/**
 * Transform one chunk with the recovery ladder: primary → (on truncation
 * or error) halve at a paragraph boundary and recurse → (when unsplittable)
 * fallback model → (on total failure) pass the ORIGINAL text through with a
 * failure flag. A hole in a translated document is worse than an
 * untransformed passage the notice points at.
 */
const transformChunk = async (
  chunk: string,
  instruction: string,
): Promise<ChunkOutcome> => {
  try {
    const primary = await callTransformLlm(
      transformPrimary.model,
      chunk,
      instruction,
    );
    if (!primary.truncated) {
      return {
        output: primary.text,
        failed: false,
        truncated: false,
        usedFallback: false,
      };
    }
    const parts = splitChunk(chunk);
    if (parts.length >= 2) return transformParts(parts, instruction);
    // Unsplittable and truncated — keep the capped output, flag it.
    return {
      output: primary.text,
      failed: false,
      truncated: true,
      usedFallback: false,
    };
  } catch (primaryError) {
    console.warn(
      `[transform] primary failed on ${TRANSFORM_MODEL_ID} — ${describeLlmError(primaryError)}`,
    );
    const parts = splitChunk(chunk);
    if (parts.length >= 2) return transformParts(parts, instruction);
    try {
      const fallback = await callTransformLlm(
        transformFallback.model,
        chunk,
        instruction,
      );
      return {
        output: fallback.text,
        failed: false,
        truncated: fallback.truncated,
        usedFallback: true,
      };
    } catch (fallbackError) {
      console.error(
        `[transform] both models failed — ${describeLlmError(fallbackError)}`,
      );
      return {
        output: chunk,
        failed: true,
        truncated: false,
        usedFallback: true,
      };
    }
  }
};

/** Transform split halves in parallel and re-join them at the paragraph seam. */
const transformParts = async (
  parts: readonly string[],
  instruction: string,
): Promise<ChunkOutcome> => {
  const outcomes = await mapBounded(
    parts,
    TRANSFORM_CHUNK_CONCURRENCY,
    (part) => transformChunk(part, instruction),
  );
  return {
    output: outcomes.map((outcome) => outcome.output).join("\n\n"),
    failed: outcomes.some((outcome) => outcome.failed),
    truncated: outcomes.some((outcome) => outcome.truncated),
    usedFallback: outcomes.some((outcome) => outcome.usedFallback),
  };
};

export interface ProseTransformResult {
  /** The model(s) that served — `primary` or `primary+fallback`. */
  model: string;
  chunks: number;
  /** False when any chunk failed or was truncated — see `notices`. */
  complete: boolean;
  notices: string[];
  output: string;
}

/**
 * Merge chunk outcomes into the tool-facing result: concatenate the
 * transformed text in order, and emit a notice per failed (original passed
 * through) or truncated section so the agent can re-run just that part.
 * Pure — split from the LLM map so the assembly is unit-testable.
 */
export const assembleTransformResult = (
  outcomes: readonly ChunkOutcome[],
): ProseTransformResult => {
  const notices: string[] = [];
  outcomes.forEach((outcome, index) => {
    const label = `Section ${(index + 1).toString()}/${outcomes.length.toString()}`;
    if (outcome.failed) {
      notices.push(
        `${label} could not be transformed (both models failed) — its ORIGINAL text was kept in place. Re-run transform on that section alone, or handle it manually.`,
      );
    } else if (outcome.truncated) {
      notices.push(
        `${label} hit the output cap and may be incomplete — re-run transform on that section with a tighter instruction.`,
      );
    }
  });
  const usedFallback = outcomes.some((outcome) => outcome.usedFallback);
  return {
    model: usedFallback
      ? `${TRANSFORM_MODEL_ID}+${TRANSFORM_FALLBACK_MODEL_ID}`
      : TRANSFORM_MODEL_ID,
    chunks: outcomes.length,
    complete: notices.length === 0,
    notices,
    output: outcomes.map((outcome) => outcome.output).join("\n\n"),
  };
};

/**
 * Transform every chunk (bounded concurrency, order-preserving) and
 * concatenate the results into one document. Terminology/style consistency
 * rides the shared `instruction` — the caller puts any glossary in it.
 */
export const runProseTransform = async (args: {
  chunks: readonly string[];
  instruction: string;
}): Promise<ProseTransformResult> => {
  const outcomes = await mapBounded(
    args.chunks,
    TRANSFORM_CHUNK_CONCURRENCY,
    (chunk) => transformChunk(chunk, args.instruction),
  );
  return assembleTransformResult(outcomes);
};
