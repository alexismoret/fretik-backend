import { type LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { telemetryFor } from "./langfuse";
import { resolveModel } from "./model-registry/resolve";
import { resolveModelForTeam } from "./model-registry/team-model";

/**
 * Vision sub-model for the `vision` tool — the registry's `vision`
 * role (shared with the `extract` engine). The primary
 * chat model never sees image or PDF bytes — this keeps the hot-path
 * context cheap and isolates vision cost behind an explicit tool call.
 *
 * Reasoning is pinned to `minimal` and temperature is dropped: Gemini 3.x
 * mandates reasoning (it counts against the output cap) and returns EMPTY at
 * `temperature:0` — the same two knobs the `extract` engine learned from the
 * WS0 replay. See `lib/structured-extract.ts`.
 *
 * Contract: the caller hands raw bytes (already read from the
 * conversation sandbox via the storage façade) plus the mime type
 * and an optional filename. We send those straight to OpenRouter —
 * no local disk roundtrip.
 *
 *  - Images (.png/.jpg/.webp) go as a `type: "file"` content part with an
 *    `image/*` mediaType — the OpenRouter provider maps it to an `image_url`
 *    block (v7 deprecates the standalone `image` part).
 *  - PDFs go as a `type: "file"` content part, with OpenRouter's
 *    `file-parser` plugin pinned to `engine: "native"` so Gemini
 *    receives the raw PDF instead of OpenRouter's default
 *    Mistral-OCR conversion.
 *  - Videos (.mp4/.webm/.mov) go as a `type: "file"` content part; the
 *    OpenRouter provider maps a `video/*` mediaType to a `video_url`
 *    block. Primary-only — see `describeVideo`.
 *
 * **Primary → fallback (Sprint B §3.7).** When the primary vision
 * model errors out (timeout, transport, provider rate-limit, schema
 * failure), we transparently retry on the registry's
 * `vision-fallback` role (default `openai/gpt-4o-mini`). Mirrors the
 * chat primary→fallback pattern in `agents/shared/agent-builder.ts`.
 * Both errors propagate to the caller (the `vision` tool surface,
 * which formats them as a typed `error` field) only if BOTH models
 * fail — otherwise the agent never sees the transient failure.
 */

/**
 * The team's vision model, resolved PER CALL.
 *
 * It used to be two module-level constants, which was wrong twice over. A team
 * that picked a vision model got the code default anyway — the `vision` role
 * was pinned "fixed", so there was nothing to pick — and, less visibly, the
 * resolved instances were captured at import and never refreshed, so a
 * quarantine written at 03:00 did not reach this path until the process
 * restarted. Both are the defect the engine exists to remove.
 *
 * The FALLBACK stays on the code default on purpose: it is the redundancy, and
 * a fallback a team can repoint onto its own primary is not one.
 */
const visionModelsFor = async (teamId: string | undefined) => {
  const primary = await resolveModelForTeam("vision", teamId);
  const fallback = resolveModel("vision-fallback");
  return {
    primary: primary.model,
    primaryId: primary.profile.catalog.id,
    fallback: fallback.model,
    fallbackId: fallback.profile.catalog.id,
  };
};

const DEFAULT_TIMEOUT_MS = 60_000;
/** Video decoding/inference runs longer than a still image. */
const VIDEO_TIMEOUT_MS = 120_000;
/**
 * Output ceiling for a description. Raised from 1500 after a live case
 * where a JSON-ish answer was cut mid-object at 1423 tokens with no
 * signal to the agent — the cap is now paired with `truncated` (from
 * `finishReason`) so a capped answer is always visible to the caller.
 * Bulk structured extraction does not belong here (that's `extract`).
 */
// Reasoning counts against this cap on Gemini 3.x, so leave headroom above the
// answer itself — a describe truncated by thinking would be surfaced as
// `truncated` but is a waste.
const MAX_OUTPUT_TOKENS = 8_000;

/** Mandatory Gemini reasoning pinned to the least; native-PDF route added per
 * call where the source is a PDF. No temperature (Vertex ZDR omits it; temp:0
 * returns empty on Gemini 3.x). */
const VISION_PROVIDER_OPTIONS = {
  openrouter: { reasoning: { effort: "minimal" as const } },
};
const VISION_PDF_PROVIDER_OPTIONS = {
  openrouter: {
    reasoning: { effort: "minimal" as const },
    plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
  },
};

/**
 * Run a primary→fallback chain and return the result of whichever
 * succeeds first. The primary error is logged (the model id matters
 * for ops triage) but only the fallback error escapes the function
 * if both fail. Caller-supplied builder receives a `LanguageModel`
 * and the model id; the id flows back into `DescribeFileResult.model`
 * so the agent can see which one actually answered.
 */
const runWithVisionFallback = async <T>(
  teamId: string | undefined,
  builder: (model: LanguageModelV4, modelId: string) => Promise<T>,
): Promise<T> => {
  const models = await visionModelsFor(teamId);
  try {
    return await builder(models.primary, models.primaryId);
  } catch (primaryErr) {
    console.warn(
      `[vision] primary model ${models.primaryId} failed, falling back to ${models.fallbackId}:`,
      primaryErr instanceof Error ? primaryErr.message : primaryErr,
    );
    return builder(models.fallback, models.fallbackId);
  }
};

export interface DescribeFileResult {
  description: string;
  model: string;
  question: string;
  /** True when the model hit the output-token cap (`finishReason === "length"`). */
  truncated: boolean;
}

export interface DescribeImageArgs {
  /** Whose vision model to use. Absent on paths with no team in scope. */
  teamId?: string;
  /** Raw image bytes. */
  bytes: Uint8Array;
  /** Original MIME type, used on the `image` content part. */
  mimeType: string;
  /** Explicit visual question from the agent — mandatory, no default. */
  question: string;
}

export const describeImage = async (
  args: DescribeImageArgs,
): Promise<DescribeFileResult> => {
  return runWithVisionFallback(args.teamId, async (model, modelId) => {
    const { text, finishReason } = await generateText({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      // Nests under the `vision` tool call → under `chatbot-turn`.
      telemetry: telemetryFor("vision"),
      messages: [
        {
          role: "user",
          content: [
            {
              // v7 deprecates the `image` content part → unified `file` part
              // (`ImagePart` is @deprecated). The OpenRouter provider branches
              // on `mediaType`: `image/*` → an `image_url` block for the vision
              // model, exactly as the old `image` part did. (Same `file` part as
              // the PDF/video paths below — the mediaType is what distinguishes.)
              type: "file",
              data: args.bytes,
              mediaType: args.mimeType,
            },
            {
              type: "text",
              text: args.question,
            },
          ],
        },
      ],
      providerOptions: VISION_PROVIDER_OPTIONS,
    });

    return {
      description: text.trim(),
      model: modelId,
      question: args.question,
      truncated: finishReason === "length",
    };
  });
};

export interface DescribePdfArgs {
  /** Whose vision model to use. Absent on paths with no team in scope. */
  teamId?: string;
  /** Raw PDF bytes. */
  bytes: Uint8Array;
  /** Optional original filename — forwarded to OpenRouter on the file content part. */
  filename?: string;
  /** Explicit visual question from the agent — mandatory, no default. */
  question: string;
}

/**
 * Describe a PDF by sending its raw bytes to the vision model,
 * bypassing OpenRouter's default Mistral-OCR conversion via the
 * `file-parser` plugin pinned to `engine: "native"`. Gemini 3.1
 * Flash Lite Preview natively ingests PDFs; forcing `native` keeps
 * the full document (layout, diagrams, signatures) in front of the
 * model instead of a flattened OCR pass.
 *
 * Note: the fallback model may handle the same plugin differently
 * (e.g. OpenAI routes ignore the `file-parser` plugin and process
 * the PDF natively as multimodal input). Forwarding the
 * `providerOptions` is safe — unknown plugin ids are silently
 * dropped by providers that don't support them.
 */
export const describePdf = async (
  args: DescribePdfArgs,
): Promise<DescribeFileResult> => {
  return runWithVisionFallback(args.teamId, async (model, modelId) => {
    const { text, finishReason } = await generateText({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      // Nests under the `vision` tool call → under `chatbot-turn`.
      telemetry: telemetryFor("vision"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: args.bytes,
              mediaType: "application/pdf",
              filename: args.filename ?? "document.pdf",
            },
            {
              type: "text",
              text: args.question,
            },
          ],
        },
      ],
      providerOptions: VISION_PDF_PROVIDER_OPTIONS,
    });

    return {
      description: text.trim(),
      model: modelId,
      question: args.question,
      truncated: finishReason === "length",
    };
  });
};

export interface DescribeVideoArgs {
  /** Whose vision model to use. Absent on paths with no team in scope. */
  teamId?: string;
  /** Raw video bytes. */
  bytes: Uint8Array;
  /** Original MIME type (e.g. `video/mp4`), used on the `file` content part. */
  mimeType: string;
  /** Optional original filename — forwarded to OpenRouter on the file part. */
  filename?: string;
  /** Explicit visual question from the agent — mandatory, no default. */
  question: string;
}

/**
 * Describe a video by sending its raw bytes to the PRIMARY vision model
 * only. Gemini 3.6 Flash ingests video natively; the OpenRouter provider
 * serialises a `file` part with a `video/*` mediaType as a `video_url`
 * block. NO fallback: both vision roles are Google Gemini, so a second
 * route adds cost without real resilience for a one-shot describe. On
 * failure the error propagates to the `vision` tool surface as a typed
 * error and the agent can retry next turn.
 */
export const describeVideo = async (
  args: DescribeVideoArgs,
): Promise<DescribeFileResult> => {
  const models = await visionModelsFor(args.teamId);
  const { text, finishReason } = await generateText({
    model: models.primary,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
    // Nests under the `vision` tool call → under `chatbot-turn`.
    telemetry: telemetryFor("vision"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: args.bytes,
            mediaType: args.mimeType,
            filename: args.filename ?? "video",
          },
          {
            type: "text",
            text: args.question,
          },
        ],
      },
    ],
    providerOptions: VISION_PROVIDER_OPTIONS,
  });

  return {
    description: text.trim(),
    model: models.primaryId,
    question: args.question,
    truncated: finishReason === "length",
  };
};

export interface DescribeVisionFileArgs {
  /** Whose vision model to use. Absent on paths with no team in scope. */
  teamId?: string;
  bytes: Uint8Array;
  mimeType: string;
  question: string;
  /** Optional filename, forwarded to PDF / video content parts. */
  filename?: string;
}

/**
 * Dispatches to the correct per-MIME vision helper so the tool
 * surface stays single-entry.
 */
export const describeVisionFile = async (
  args: DescribeVisionFileArgs,
): Promise<DescribeFileResult> => {
  if (args.mimeType === "application/pdf") {
    return describePdf({
      teamId: args.teamId,
      bytes: args.bytes,
      filename: args.filename,
      question: args.question,
    });
  }
  if (args.mimeType.startsWith("video/")) {
    return describeVideo({
      teamId: args.teamId,
      bytes: args.bytes,
      mimeType: args.mimeType,
      filename: args.filename,
      question: args.question,
    });
  }
  return describeImage({
    teamId: args.teamId,
    bytes: args.bytes,
    mimeType: args.mimeType,
    question: args.question,
  });
};
