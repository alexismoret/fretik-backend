import { type LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { telemetryFor } from "./langfuse";
import { resolveModel } from "./model-registry/resolve";

/**
 * Vision sub-model for the `vision` tool — the registry's `vision`
 * role (default Gemini 3.1 Flash Lite). The primary chat model never
 * sees image or PDF bytes — this keeps the hot-path context cheap and
 * isolates vision cost behind an explicit tool call.
 *
 * Contract: the caller hands raw bytes (already read from the
 * conversation sandbox via the storage façade) plus the mime type
 * and an optional filename. We send those straight to OpenRouter —
 * no local disk roundtrip.
 *
 *  - Images (.png/.jpg/.webp) go as a `type: "image"` content part.
 *  - PDFs go as a `type: "file"` content part, with OpenRouter's
 *    `file-parser` plugin pinned to `engine: "native"` so Gemini
 *    receives the raw PDF instead of OpenRouter's default
 *    Mistral-OCR conversion.
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

const visionPrimary = resolveModel("vision");
const visionFallback = resolveModel("vision-fallback");

const VISION_MODEL_ID = visionPrimary.profile.catalog.id;
const VISION_FALLBACK_MODEL_ID = visionFallback.profile.catalog.id;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1_500;
const TEMPERATURE = 0.2;

const visionModel = visionPrimary.model;
const visionFallbackModel = visionFallback.model;

/**
 * Run a primary→fallback chain and return the result of whichever
 * succeeds first. The primary error is logged (the model id matters
 * for ops triage) but only the fallback error escapes the function
 * if both fail. Caller-supplied builder receives a `LanguageModel`
 * and the model id; the id flows back into `DescribeFileResult.model`
 * so the agent can see which one actually answered.
 */
const runWithVisionFallback = async <T>(
  builder: (model: LanguageModelV3, modelId: string) => Promise<T>,
): Promise<T> => {
  try {
    return await builder(visionModel, VISION_MODEL_ID);
  } catch (primaryErr) {
    console.warn(
      `[vision] primary model ${VISION_MODEL_ID} failed, falling back to ${VISION_FALLBACK_MODEL_ID}:`,
      primaryErr instanceof Error ? primaryErr.message : primaryErr,
    );
    return builder(visionFallbackModel, VISION_FALLBACK_MODEL_ID);
  }
};

export interface DescribeFileResult {
  description: string;
  model: string;
  question: string;
}

export interface DescribeImageArgs {
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
  return runWithVisionFallback(async (model, modelId) => {
    const { text } = await generateText({
      model,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      // Nests under the `vision` tool call → under `chatbot-turn`.
      experimental_telemetry: telemetryFor("vision"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: args.bytes,
              mediaType: args.mimeType,
            },
            {
              type: "text",
              text: args.question,
            },
          ],
        },
      ],
    });

    return {
      description: text.trim(),
      model: modelId,
      question: args.question,
    };
  });
};

export interface DescribePdfArgs {
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
  return runWithVisionFallback(async (model, modelId) => {
    const { text } = await generateText({
      model,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      // Nests under the `vision` tool call → under `chatbot-turn`.
      experimental_telemetry: telemetryFor("vision"),
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
      providerOptions: {
        openrouter: {
          plugins: [
            {
              id: "file-parser",
              pdf: { engine: "native" },
            },
          ],
        },
      },
    });

    return {
      description: text.trim(),
      model: modelId,
      question: args.question,
    };
  });
};

export interface DescribeVisionFileArgs {
  bytes: Uint8Array;
  mimeType: string;
  question: string;
  /** Optional filename, forwarded to PDF content parts. */
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
      bytes: args.bytes,
      filename: args.filename,
      question: args.question,
    });
  }
  return describeImage({
    bytes: args.bytes,
    mimeType: args.mimeType,
    question: args.question,
  });
};
