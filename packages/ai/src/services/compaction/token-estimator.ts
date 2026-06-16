import { isFileUIPart, type UIMessage } from "ai";
import type { ModelProfile } from "../../lib/model-registry/types";
import { mediaModality, resolveAttachmentIngestion } from "../native-input";

/**
 * Cheap chars/4 token heuristic. The BPE tokenisers used by most upstream
 * models (cl100k_base, o200k_base, MiniMax tokenizer) land in a narrow band
 * around 3.5-4 chars per token for English and 2.5-3 for dense CJK text. We
 * use 4 as a conservative ceiling — slightly over-estimates English, mildly
 * under-estimates CJK, which is the right bias for a compaction threshold:
 * kicks in a hair earlier than the true token count rather than later.
 *
 * Same heuristic Anthropic uses internally
 * (`claude-code/src/utils/tokens.ts`) and what every other `CHEAP_MODEL`
 * consumer implicitly assumes when sizing a prompt.
 */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * Rough token count for a `UIMessage[]`. Serialises the whole array via
 * `JSON.stringify` and feeds the result through `estimateTokens`. This
 * handles text parts, tool-call parts, reasoning parts, and future part
 * kinds uniformly without enumerating the discriminated union — the JSON
 * envelope (quotes, braces, keys) slightly inflates the byte count vs the
 * actual prompt, which reinforces the "fire a bit earlier than needed"
 * bias mentioned above.
 *
 * Returns 0 on the (theoretical) case where serialisation throws — e.g.
 * circular refs. Messages reaching this layer come from the DB (`parts` is
 * JSONB) or from the AI SDK's own `convertToModelMessages` input, so this
 * is defensive, never actually hit.
 */
/**
 * Coarse per-part surcharge for media a profile sends NATIVELY (C5). The
 * persisted `file` part is a tiny URL, so `JSON.stringify` under-counts a
 * native image/video by orders of magnitude; without this the compaction
 * threshold would never account for the real prompt weight. Constants are
 * deliberately conservative-high (fire a hair early) — same bias as the
 * chars/4 heuristic; an image ≈ 1 000 tokens, a video clip far more.
 */
const NATIVE_IMAGE_TOKENS = 1_000;
const NATIVE_VIDEO_TOKENS = 10_000;

const nativeMediaSurcharge = (
  messages: UIMessage[],
  profile: ModelProfile,
): number => {
  let surcharge = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isFileUIPart(part)) continue;
      if (resolveAttachmentIngestion(part, profile) !== "native") continue;
      const modality = mediaModality(part.mediaType);
      if (modality === "image") surcharge += NATIVE_IMAGE_TOKENS;
      else if (modality === "video") surcharge += NATIVE_VIDEO_TOKENS;
    }
  }
  return surcharge;
};

/**
 * Rough token count for a `UIMessage[]`. Pass the active `profile` so
 * media it would send native is costed (otherwise the tiny file-part URL
 * is all that's counted). Without a profile — or for tool-mediated parts —
 * the estimate is the historical `JSON.stringify` baseline unchanged.
 */
export const estimateMessagesTokens = (
  messages: UIMessage[],
  profile?: ModelProfile,
): number => {
  try {
    const base = estimateTokens(JSON.stringify(messages));
    return profile ? base + nativeMediaSurcharge(messages, profile) : base;
  } catch {
    return 0;
  }
};
