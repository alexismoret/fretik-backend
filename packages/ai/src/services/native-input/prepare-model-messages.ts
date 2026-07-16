import { sanitizeSessionPath } from "@fretik/shared/lib/chatbot-session-storage";
import { type FileUIPart, isFileUIPart, type UIMessage } from "ai";
import {
  type ModelProfile,
  NATIVE_FILE_MAX_BYTES,
} from "../../lib/model-registry/types";
import {
  mediaModality,
  type NativeModality,
  resolveAttachmentIngestion,
} from "./resolve-attachment-ingestion";

/**
 * Native multimodal input (chantier C5) — the I/O transformation that
 * turns chat attachments into NATIVE content parts for multimodal model
 * profiles, replacing the unconditional `stripFilePartsForModel` at both
 * stream call sites.
 *
 * Contract:
 * - Always strips prior-turn reasoning parts first
 *   (`stripReasoningPartsForModel`) — reasoning is never re-sent (provider
 *   signature bug #423 + zombie risk; see that helper).
 * - Runs the pure `resolveAttachmentIngestion` over every file part.
 * - When NOTHING travels native (every current profile, and every
 *   non-multimodal profile), returns `stripFilePartsForModel(base)` — file +
 *   reasoning stripped. That fast path is the fallback branch the plan keeps;
 *   the strip helper is not deleted, it lives here.
 * - Otherwise keeps the most-recent N native parts per modality (provider
 *   hard limit), demoting older ones back to tool-mediated, and rewrites
 *   each kept-native part:
 *     - image → base64 data URL (inlined; small, re-resolved every turn).
 *     - video → fresh presigned URL (by reference; avoids re-inlining a
 *       multi-MB clip every turn — OpenRouter passes it as `video_url`).
 *     - file (C5v2, PDF) → base64 data URL like images (the provider-portable
 *       transport for `file` parts), bounded by `limits.maxFileBytes` —
 *       an oversized file demotes to tool-mediated, never errors. The
 *       stream call sites add the OpenRouter `file-parser` plugin
 *       (request-level) when `hasNativeFileParts` is true.
 *
 * NEVER mutates the input: the base64/URL lives ONLY in the transient
 * model messages, never written back to the persisted history. Any I/O
 * failure drops that one part to tool-mediated (the agent can still reach
 * it via `read`/`vision`) — it never throws.
 */
export interface PrepareModelMessagesDeps {
  /** Active conversation; undefined on stateless paths (e.g. headless invoke). */
  conversationId: string | undefined;
  /** Read a session file's bytes — image inline. Mirrors `readSessionFile`. */
  readSessionFile: (
    conversationId: string,
    relative: string,
  ) => Promise<Uint8Array | null>;
  /** Mint a fresh presigned GET URL — video by reference. Mirrors `getSessionFilePresignedUrl`. */
  presignSessionFile: (
    conversationId: string,
    relative: string,
  ) => Promise<string>;
}

/**
 * Strip every file part from the messages the model sees. The model
 * reaches attachments only through `read`/`vision`/`python`, never raw
 * bytes or URLs. This is the tool-mediated branch — kept as the fast
 * path of `prepareModelMessages` for non-multimodal / inert profiles.
 */
export const stripFilePartsForModel = (messages: UIMessage[]): UIMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => !isFileUIPart(part)),
  }));

/**
 * Strip reasoning parts from the prior-turn history the model sees, ALWAYS.
 *
 * The OpenRouter provider re-validates `reasoning_details` signatures when it
 * re-sends our assistant messages and silently DROPS Gemini/Claude reasoning
 * whose signature is missing — a turn cut off mid-reasoning (a "zombie":
 * finishReason `length`/`other`) never receives the signature-only final delta,
 * because the provider's `doStream` doesn't accumulate it
 * (OpenRouterTeam/ai-sdk-provider#423, unfixed through 2.9.1). Re-sending that
 * half-signed reasoning logs a per-turn warning AND feeds reasoning models an
 * inconsistent context — a plausible reasoning-only zombie trigger.
 *
 * Dropping prior-turn reasoning gives every model a clean fresh-reasoning-each-
 * turn context — the maintainer-recommended workaround. It touches ONLY the
 * persisted history fed in here; the live in-turn tool loop keeps its own
 * fresh-signature reasoning, so interleaved thinking+tool-use is unaffected.
 */
export const stripReasoningPartsForModel = (
  messages: UIMessage[],
): UIMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type !== "reasoning"),
  }));

const ATTACHMENTS_DIR = "attachments";

const capForModality = (
  modality: NativeModality,
  limits: ModelProfile["assessment"]["nativeInput"]["limits"],
): number | undefined => {
  if (!limits) return undefined;
  if (modality === "image") return limits.maxImagesPerRequest;
  if (modality === "video") return limits.maxVideosPerRequest;
  if (modality === "file") return limits.maxFilesPerRequest;
  return undefined;
};

const toNativeFilePart = async (
  part: FileUIPart,
  profile: ModelProfile,
  deps: PrepareModelMessagesDeps,
): Promise<FileUIPart | null> => {
  const { conversationId } = deps;
  const { filename, mediaType } = part;
  // Without a conversation + filename the S3 object is unaddressable →
  // fall back to tool-mediated (drop) rather than guess.
  if (!conversationId || !filename) return null;
  const relative = sanitizeSessionPath(`${ATTACHMENTS_DIR}/${filename}`);
  try {
    if (mediaModality(mediaType) === "video") {
      const url = await deps.presignSessionFile(conversationId, relative);
      return { ...part, url };
    }
    const bytes = await deps.readSessionFile(conversationId, relative);
    if (!bytes) return null;
    // Files (PDF) are heavy when inlined and re-sent every turn — an
    // oversized one demotes to tool-mediated instead of bloating the
    // request. `filename` is preserved by the spread (providers need it
    // on file parts).
    if (mediaModality(mediaType) === "file") {
      const maxBytes =
        profile.assessment.nativeInput.limits?.maxFileBytes ??
        NATIVE_FILE_MAX_BYTES;
      if (bytes.byteLength > maxBytes) return null;
    }
    const base64 = Buffer.from(bytes).toString("base64");
    return { ...part, url: `data:${mediaType};base64,${base64}` };
  } catch (err) {
    console.warn(
      `[native-input] failed to prepare ${filename} (${mediaType}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
};

/**
 * OpenRouter `file-parser` plugin pinned to the native engine — sent
 * request-level when the turn carries a native PDF, so OpenRouter hands
 * the raw file to the model instead of running its default Mistral-OCR
 * conversion (which would silently charge AND flatten the document).
 * Providers that don't support the plugin drop unknown ids silently
 * (same behavior as the `vision` tool's PDF path in `lib/vision.ts`).
 */
export const NATIVE_FILE_PARSER_PLUGINS = [
  { id: "file-parser", pdf: { engine: "native" } },
];

/**
 * True when at least one file part in the history rides natively as a
 * `file`-modality part for this profile. The stream call sites use it to
 * attach the OpenRouter `file-parser` plugin (request-level) ONLY on
 * requests that actually carry a native PDF — everything else keeps its
 * exact current provider options (byte-identical inert guard).
 */
export const hasNativeFileParts = (
  messages: UIMessage[],
  profile: ModelProfile,
): boolean =>
  messages.some((message) =>
    message.parts.some(
      (part) =>
        isFileUIPart(part) &&
        mediaModality(part.mediaType) === "file" &&
        resolveAttachmentIngestion(part, profile) === "native",
    ),
  );

export const prepareModelMessages = async (
  history: UIMessage[],
  profile: ModelProfile,
  deps: PrepareModelMessagesDeps,
): Promise<UIMessage[]> => {
  // Reasoning is never re-sent (provider signature bug #423 + zombie risk):
  // strip it from the persisted history before any file/native handling.
  const base = stripReasoningPartsForModel(history);

  // Plan pass — native-eligible file parts per modality, in conversation
  // order (array order == chronological).
  const nativeByModality = new Map<NativeModality, FileUIPart[]>();
  for (const message of base) {
    for (const part of message.parts) {
      if (!isFileUIPart(part)) continue;
      if (resolveAttachmentIngestion(part, profile) !== "native") continue;
      const modality = mediaModality(part.mediaType);
      if (!modality) continue;
      const bucket = nativeByModality.get(modality) ?? [];
      bucket.push(part);
      nativeByModality.set(modality, bucket);
    }
  }

  // Fast path — nothing native (inert / non-multimodal): file-stripped
  // (reasoning already stripped above), no I/O.
  if (nativeByModality.size === 0) return stripFilePartsForModel(base);

  // Recency cap per modality — keep the most-recent N; older native parts
  // demote to tool-mediated (the agent can re-`read`/`vision` them).
  const keepNative = new Set<FileUIPart>();
  const { limits } = profile.assessment.nativeInput;
  for (const [modality, parts] of nativeByModality) {
    const cap = capForModality(modality, limits);
    const kept =
      cap === undefined || cap >= parts.length
        ? parts
        : parts.slice(parts.length - cap);
    for (const part of kept) keepNative.add(part);
  }

  // Transform pass — non-file parts untouched; kept-native parts rewritten;
  // tool-mediated, demoted, and I/O-failed parts dropped. New objects only.
  type Part = UIMessage["parts"][number];
  return Promise.all(
    base.map(async (message) => {
      const parts = await Promise.all(
        message.parts.map(async (part): Promise<Part | null> => {
          if (!isFileUIPart(part)) return part;
          if (!keepNative.has(part)) return null;
          return toNativeFilePart(part, profile, deps);
        }),
      );
      return {
        ...message,
        parts: parts.filter((part): part is Part => part !== null),
      };
    }),
  );
};
