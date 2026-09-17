import { redis } from "../../lib/redis";

/**
 * Turns whose output must never reach history.
 *
 * A turn keeps running for a while after it is cancelled: `/stop` publishes on
 * the abort channel, the producer unwinds, and its `onFinish` still persists
 * whatever streamed. That is exactly what we want for a plain Stop — the
 * partial answer is kept — and exactly what we must NOT have when a user
 * rewinds the conversation by editing one of their messages.
 *
 * The difference is the rewind's DELETE. A cancelled turn's rows already exist
 * (the recorder wrote them), so an ordinary late `onFinish` upserts them in
 * place and the transcript order is preserved. Delete those rows and the same
 * late write becomes an INSERT: fresh `seq` values, landing AFTER the edited
 * message and interleaved with the turn that replaced it — a stale answer to a
 * prompt that no longer exists, sitting under the new one.
 *
 * So the rewind marks the turn discarded and both write paths
 * (`upsertPartialMessage`, the handler's `onFinish` persistence) drop it. The
 * marker is short-lived on purpose: it only has to outlive the dying producer,
 * and nothing can resurrect the turn afterwards — the rewind clears the
 * conversation's active-stream slot, so no resume ever finds its log to drain.
 */

/** Long enough to outlive any producer still unwinding, short enough to forget. */
const DISCARDED_TURN_TTL_S = 7_200;

const discardedKey = (turnId: string): string =>
  `fretik-chatbot-discarded-turn:${turnId}`;

/** Mark a turn's output as unwanted. Idempotent. */
export const markTurnDiscarded = async (turnId: string): Promise<void> => {
  await redis.set(discardedKey(turnId), "1", "EX", DISCARDED_TURN_TTL_S);
};

/**
 * Is this turn's output unwanted? `null`/`undefined` answers `false` — a
 * message with no turn id predates the turn log and cannot have been rewound
 * out from under a live producer.
 *
 * Never throws: Redis being unreachable must not stop a turn from persisting.
 * The failure mode it degrades to (a stale partial re-appearing after an edit)
 * is strictly better than losing every answer while Redis is down.
 */
export const isTurnDiscarded = async (
  turnId: string | null | undefined,
): Promise<boolean> => {
  if (!turnId) return false;
  try {
    return (await redis.exists(discardedKey(turnId))) === 1;
  } catch {
    return false;
  }
};
