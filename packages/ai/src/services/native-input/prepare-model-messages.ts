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

/**
 * Tool parts of RETIRED tools, stripped from the history the model sees.
 * A stored conversation may carry tool calls for a tool that no longer
 * exists in any registry — replaying such a part would reference a tool
 * the provider has no definition for. Stripping is lossless for these
 * tools: their outputs were ephemeral UI state, never load-bearing facts.
 *
 *  - `tool-manageTasks` — the per-turn checklist tool, removed 2026-07
 *    (the workflows feature replaced the need; see the refonte plan).
 */
const RETIRED_TOOL_PART_TYPES = new Set(["tool-manageTasks"]);

export const stripRetiredToolPartsForModel = (
  messages: UIMessage[],
): UIMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.filter(
      (part) => !RETIRED_TOOL_PART_TYPES.has(part.type),
    ),
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

/**
 * Native-eligible file parts, after the per-modality recency cap. Shared by
 * the transform pass and `planNativeIngestion`, so what the prompt claims can
 * never disagree with what was actually sent.
 */
const planNativeParts = (
  messages: UIMessage[],
  profile: ModelProfile,
): Set<FileUIPart> => {
  // Native-eligible file parts per modality, in conversation order
  // (array order == chronological), each tagged with its message index.
  const nativeByModality = new Map<
    NativeModality,
    { part: FileUIPart; messageIndex: number }[]
  >();
  // A document rides natively only on the turn it ARRIVES — the "look at
  // this" moment. Afterwards it stays reachable through `read` / `extract` /
  // `vision`, and the prompt names it as such. Measured 2026-07-29: the same
  // two PDFs re-sent on all 18 steps of a 3-turn thread were ~1.1M of the
  // conversation's 2.18M input tokens, ~60k per step, and the agent answered
  // from none of them. Images and video are exempt: an image costs 1-2k
  // tokens, and "what's in the chart you sent earlier" is a real ask.
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts) {
      if (!isFileUIPart(part)) continue;
      if (resolveAttachmentIngestion(part, profile) !== "native") continue;
      const modality = mediaModality(part.mediaType);
      if (!modality) continue;
      if (modality === "file" && messageIndex !== lastUserIndex) continue;
      const bucket = nativeByModality.get(modality) ?? [];
      bucket.push({ part, messageIndex });
      nativeByModality.set(modality, bucket);
    }
  });

  // Cap per modality: newest MESSAGE first, then the order the files were
  // given INSIDE that message. Recency only ranks messages — inside one, every
  // file arrived at the same instant, so "most recent" is meaningless there.
  // Slicing the tail dropped whichever file the user happened to list first:
  // a 2026-07-28 run sent 3 PDFs in one message under a cap of 2 and silently
  // excluded the primary document. Files past the cap demote to tool-mediated
  // (the agent can still `read` / `vision` them, and the prompt names them).
  const keepNative = new Set<FileUIPart>();
  const { limits } = profile.assessment.nativeInput;
  for (const [modality, entries] of nativeByModality) {
    const cap = capForModality(modality, limits);
    if (cap === undefined || cap >= entries.length) {
      for (const { part } of entries) keepNative.add(part);
      continue;
    }
    const ranked = entries
      .map((entry, position) => ({ ...entry, position }))
      .sort(
        (a, b) => b.messageIndex - a.messageIndex || a.position - b.position,
      );
    for (const { part } of ranked.slice(0, cap)) keepNative.add(part);
  }
  return keepNative;
};

/**
 * WHICH files this profile actually sends natively on the next request, and
 * which the model must reach with a tool instead.
 *
 * The prompt used to state the profile's CAPABILITY ("attached PDFs are
 * directly visible in this message") — false for every file past the recency
 * cap, false for every non-native mime, and false for 100% of workflow runs.
 * Prod 2026-07-27: 4 files attached, 2 reached the model, no signal about the
 * other 2, and the agent invented an output column rather than opening the
 * example file it never knew it could read.
 *
 * Pure — same plan/cap logic as `prepareModelMessages`, no I/O. Names are
 * basenames: what `<file_attachments>` shows and what `read` takes.
 */
export interface NativeIngestionPlan {
  /** Sent as native content on this request. */
  native: string[];
  /** Present in the conversation but NOT in this request. */
  toolOnly: string[];
}

const partFilename = (part: FileUIPart): string =>
  part.filename ?? sanitizeSessionPath(part.url.split("/").pop() ?? "file");

export const planNativeIngestion = (
  history: UIMessage[],
  profile: ModelProfile,
): NativeIngestionPlan => {
  const keep = planNativeParts(history, profile);
  const native: string[] = [];
  const toolOnly: string[] = [];
  for (const message of history) {
    for (const part of message.parts) {
      if (!isFileUIPart(part)) continue;
      (keep.has(part) ? native : toolOnly).push(partFilename(part));
    }
  }
  return { native, toolOnly };
};

export const prepareModelMessages = async (
  history: UIMessage[],
  profile: ModelProfile,
  deps: PrepareModelMessagesDeps,
): Promise<UIMessage[]> => {
  // Reasoning is never re-sent (provider signature bug #423 + zombie risk):
  // strip it from the persisted history before any file/native handling.
  // Retired-tool parts (tools removed from the registry) are stripped in
  // the same pass — a provider must never see a call to an undefined tool.
  const base = stripRetiredToolPartsForModel(
    stripReasoningPartsForModel(history),
  );

  const keepNative = planNativeParts(base, profile);

  // Fast path — nothing native (inert / non-multimodal): file-stripped
  // (reasoning already stripped above), no I/O.
  if (keepNative.size === 0) return stripFilePartsForModel(base);

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
