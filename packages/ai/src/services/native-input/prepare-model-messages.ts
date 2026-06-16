import { sanitizeSessionPath } from "@fretik/shared/lib/chatbot-session-storage";
import { type FileUIPart, isFileUIPart, type UIMessage } from "ai";
import type { ModelProfile } from "../../lib/model-registry/types";
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
 * - Runs the pure `resolveAttachmentIngestion` over every file part.
 * - When NOTHING travels native (every current profile, and every
 *   non-multimodal profile), returns `stripFilePartsForModel(history)` —
 *   byte-identical to today. That fast path is the fallback branch the
 *   plan keeps; the strip helper is not deleted, it lives here.
 * - Otherwise keeps the most-recent N native parts per modality (provider
 *   hard limit), demoting older ones back to tool-mediated, and rewrites
 *   each kept-native part:
 *     - image → base64 data URL (inlined; small, re-resolved every turn).
 *     - video → fresh presigned URL (by reference; avoids re-inlining a
 *       multi-MB clip every turn — OpenRouter passes it as `video_url`).
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

const ATTACHMENTS_DIR = "attachments";

const capForModality = (
  modality: NativeModality,
  limits: ModelProfile["assessment"]["nativeInput"]["limits"],
): number | undefined => {
  if (!limits) return undefined;
  if (modality === "image") return limits.maxImagesPerRequest;
  if (modality === "video") return limits.maxVideosPerRequest;
  return undefined;
};

const toNativeFilePart = async (
  part: FileUIPart,
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

export const prepareModelMessages = async (
  history: UIMessage[],
  profile: ModelProfile,
  deps: PrepareModelMessagesDeps,
): Promise<UIMessage[]> => {
  // Plan pass — native-eligible file parts per modality, in conversation
  // order (array order == chronological).
  const nativeByModality = new Map<NativeModality, FileUIPart[]>();
  for (const message of history) {
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

  // Fast path — nothing native (inert / non-multimodal): byte-identical to
  // stripFilePartsForModel, no I/O.
  if (nativeByModality.size === 0) return stripFilePartsForModel(history);

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
    history.map(async (message) => {
      const parts = await Promise.all(
        message.parts.map(async (part): Promise<Part | null> => {
          if (!isFileUIPart(part)) return part;
          if (!keepNative.has(part)) return null;
          return toNativeFilePart(part, deps);
        }),
      );
      return {
        ...message,
        parts: parts.filter((part): part is Part => part !== null),
      };
    }),
  );
};
