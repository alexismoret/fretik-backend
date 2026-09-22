import { estimateTokens } from "@fretik/shared/lib/token-estimate";
import { isFileUIPart, type UIMessage } from "ai";
import type { ModelProfile } from "../../lib/model-registry/types";
import { mediaModality, resolveAttachmentIngestion } from "../native-input";

/**
 * Re-exported, not redefined: the heuristic and the argument for its bias live
 * in `@fretik/shared/lib/token-estimate`, which the page-history valve and the
 * AI-context budget read from the same place. Four independent copies of
 * `length / 4` is four things that agree by coincidence.
 */
export { estimateTokens };

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
 * chars/4 heuristic; an image ≈ 1 000 tokens, a video clip far more; a
 * native PDF (C5v2) sits between the two.
 */
const NATIVE_IMAGE_TOKENS = 1_000;
const NATIVE_VIDEO_TOKENS = 10_000;
const NATIVE_FILE_TOKENS = 2_000;

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
      else if (modality === "file") surcharge += NATIVE_FILE_TOKENS;
    }
  }
  return surcharge;
};

/**
 * Token count for a `UIMessage[]`. Pass the active `profile` so media it would
 * send native is costed (otherwise the tiny file-part URL is all that is
 * counted).
 *
 * Counted message by message rather than over one `JSON.stringify` of the
 * array, because the counter is now a real tokeniser and a real tokeniser costs
 * real time — 404 ms on a 1.36 MB window, paid on every turn if nothing is
 * remembered. A message is the right unit: it is immutable once settled and a
 * turn adds one or two, so a steady-state turn tokenises what arrived and reads
 * the rest out of the memo.
 */
export const estimateMessagesTokens = (
  messages: UIMessage[],
  profile?: ModelProfile,
): number => {
  try {
    let base = 0;
    for (const message of messages) base += estimateTokens(serialise(message));
    return profile ? base + nativeMediaSurcharge(messages, profile) : base;
  } catch {
    return 0;
  }
};

/**
 * One message as the bytes that stand in for it. `JSON.stringify` per message
 * rather than per array keeps the memo key stable when a NEIGHBOUR changes,
 * which is the whole point of counting per message.
 */
const serialise = (message: UIMessage): string => JSON.stringify(message);
