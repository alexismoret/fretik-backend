import type { UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import { sql } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";

/**
 * Incremental turn persistence. Consumes a tee of the turn's PRE-scrub
 * chunk stream and upserts the in-progress assistant message(s) every
 * `FLUSH_INTERVAL_MS`, marked `metadata.partial: true` + the turn id.
 *
 * Why: assistant messages used to be written ONLY in the turn's `onFinish`
 * — a crash, OOM or deploy mid-turn lost the whole turn, and a reload
 * mid-turn showed history without the in-flight turn. With the recorder,
 * history always carries the partial (at most a few seconds stale), so
 * the orphan-detection fallback ("producer died → 204 → history") shows
 * the interrupted turn instead of nothing, with an "interrupted" badge
 * keyed off `partial: true` on a turn that is no longer active.
 *
 * The final `onFinish` write stays authoritative: same wire ids, so it
 * upserts over the recorder's rows, refreshes `parts` and clears
 * `partial`. To make the reverse order safe (a late recorder flush racing
 * the final write), the recorder's upsert only applies when the existing
 * row is still marked partial — it can never downgrade a finished row.
 */

const FLUSH_INTERVAL_MS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Upsert one in-progress assistant message. Insert wins when the row is
 * new; on conflict the update is gated on the existing row still being
 * partial (same-conversation check included, mirroring `saveMessages`).
 */
const upsertPartialMessage = async (params: {
  conversationId: string;
  turnId: string;
  message: UIMessage;
}): Promise<void> => {
  const { conversationId, turnId, message } = params;
  const metadata: Record<string, unknown> = {
    ...(isRecord(message.metadata) ? message.metadata : {}),
    partial: true,
    turnId,
  };
  await db
    .insert(aiMessages)
    .values({
      id: message.id,
      conversationId,
      role: "assistant",
      parts: message.parts,
      metadata,
      turnId,
    })
    .onConflictDoUpdate({
      target: aiMessages.id,
      set: {
        parts: sql`excluded.parts`,
        metadata: sql`excluded.metadata`,
        turnId: sql`excluded.turn_id`,
      },
      setWhere: sql`${aiMessages.conversationId} = excluded.conversation_id AND ${aiMessages.metadata} ->> 'partial' = 'true'`,
    });
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drive the recorder over a turn's chunk stream. Always drains its tee
 * branch to completion (a tee backpressures the sibling branch if one
 * side stalls). Persistence failures are logged and skipped — the
 * recorder is a crash-recovery net, never a turn blocker.
 *
 * No trailing flush on clean completion: the turn's `onFinish` writes the
 * authoritative final rows; flushing here as well would just race it (and
 * the partial-gated upsert would no-op anyway once the final row landed).
 */
export const recordTurnIncrementally = async (params: {
  conversationId: string;
  turnId: string;
  chunks: ReadableStream<UIMessageChunk>;
}): Promise<void> => {
  const { conversationId, turnId, chunks } = params;
  const latest = new Map<string, UIMessage>();
  const dirty = new Set<string>();
  let flushing = false;
  let warned = false;

  const flush = async (): Promise<void> => {
    if (flushing || dirty.size === 0) return;
    flushing = true;
    const ids = [...dirty];
    dirty.clear();
    try {
      for (const id of ids) {
        const message = latest.get(id);
        if (!message) continue;
        // eslint-style sequential writes are intentional: one turn writes
        // at most a couple of messages per flush.
        // oxlint-disable-next-line no-await-in-loop
        await upsertPartialMessage({ conversationId, turnId, message });
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(
          `[turn-recorder] partial persist failed for turn ${turnId} (non-blocking):`,
          err instanceof Error ? err.message : err,
        );
      }
    } finally {
      flushing = false;
    }
  };

  const interval = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  try {
    for await (const message of readUIMessageStream({
      stream: chunks,
      // A mid-stream error chunk must not stop the recorder — the turn
      // may recover via failover and keep producing.
      terminateOnError: false,
      onError: () => undefined,
    })) {
      if (message.role !== "assistant") continue;
      // Only uuid wire ids can be persisted (uuid PK column); the chatbot
      // producer mints uuid v7 ids, so this only skips foreign callers.
      if (!UUID_RE.test(message.id)) continue;
      latest.set(message.id, message);
      dirty.add(message.id);
    }
  } catch (err) {
    console.warn(
      `[turn-recorder] stream read failed for turn ${turnId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearInterval(interval);
  }
};
