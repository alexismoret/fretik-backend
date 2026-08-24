import type { UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import { redis } from "../../lib/redis";
import { endTurnLog } from "./turn-log";
import { upsertPartialMessage } from "./turn-recorder";

/**
 * Salvage an ORPHANED turn log into conversation history.
 *
 * When a producer dies (or is judged dead) mid-turn, its Redis log still
 * holds everything the turn produced — reasoning, tool calls, tool
 * results, text — as ordered `UIMessageChunk`s. The old behaviour was to
 * clear the conversation's stream slot and let the log expire unread:
 * measured 2026-08-21, a turn's 2 703 entries (7 answered tool calls, a
 * full transcript) sat intact in Redis for their 6-hour TTL while the
 * user's reload showed an empty conversation. An orphan is DRAINED, never
 * discarded: whatever the log holds becomes persisted assistant messages,
 * marked `partial` + `interrupted`, so the fallback-to-history path shows
 * the interrupted turn instead of nothing.
 *
 * Convergent with a zombie that later finishes: the upsert is gated on the
 * row still being partial (same write as the incremental recorder), so if
 * the "dead" producer was merely starved and its `onFinish` eventually
 * runs, the final authoritative rows land over the drained ones — and in
 * the reverse order the drain refuses to downgrade them.
 *
 * Never throws: the callers' next step (clearing the slot) must happen
 * whether or not salvage worked.
 */

const drainKey = (streamId: string): string =>
  `fretik-chatbot-drain:${streamId}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The replayable chunks of a raw XRANGE result, in order. Pure and
 * exported for tests. Skips liveness pings (transient, meaningless to
 * history), the open/end markers (`m` fields), and any entry whose JSON
 * does not parse — one corrupt entry must not void the salvage of the
 * other thousands.
 */
export const parseTurnLogChunks = (
  entries: [id: string, fields: string[]][],
): UIMessageChunk[] => {
  const chunks: UIMessageChunk[] = [];
  for (const [, fields] of entries) {
    for (let i = 0; i < fields.length - 1; i += 2) {
      if (fields[i] !== "d") continue;
      const raw = fields[i + 1] ?? "";
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) continue;
        if (Reflect.get(parsed, "type") === "data-ping") continue;
        chunks.push(parsed as UIMessageChunk);
      } catch {
        // One bad entry, not a bad log.
      }
    }
  }
  return chunks;
};

export const drainTurnLogToHistory = async (params: {
  conversationId: string;
  streamId: string;
}): Promise<{ salvagedMessages: number }> => {
  const { conversationId, streamId } = params;
  try {
    // One drainer per log — concurrent resume requests race to this.
    const lock = await redis.set(drainKey(streamId), "1", "EX", 120, "NX");
    if (lock !== "OK") return { salvagedMessages: 0 };

    const entries = await redis.xrange(
      `fretik-chatbot-turn:${streamId}`,
      "-",
      "+",
    );
    const chunks = parseTurnLogChunks(entries);
    if (chunks.length === 0) return { salvagedMessages: 0 };

    // Reassemble messages exactly the way the incremental recorder does —
    // same reader, same tolerance for a mid-stream error chunk.
    const replay = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const latest = new Map<
      string,
      Parameters<typeof upsertPartialMessage>[0]["message"]
    >();
    for await (const message of readUIMessageStream({
      stream: replay,
      terminateOnError: false,
      onError: () => undefined,
    })) {
      if (message.role !== "assistant") continue;
      if (!UUID_RE.test(message.id)) continue;
      latest.set(message.id, message);
    }

    let salvaged = 0;
    for (const message of latest.values()) {
      // oxlint-disable-next-line no-await-in-loop -- a turn holds a couple
      await upsertPartialMessage({
        conversationId,
        turnId: streamId,
        message: {
          ...message,
          metadata: {
            ...(typeof message.metadata === "object" &&
            message.metadata !== null
              ? message.metadata
              : {}),
            interrupted: true,
          },
        },
      });
      salvaged += 1;
    }

    // Terminal marker: late-attaching readers replay the salvaged turn and
    // get a clean [DONE] instead of timing out on a silence that will
    // never end, and the log's TTL drops to the post-turn window.
    await endTurnLog(streamId, "error");
    return { salvagedMessages: salvaged };
  } catch (err) {
    console.error(
      `[turn-drain] salvage failed for ${streamId} (slot will clear anyway):`,
      err instanceof Error ? err.message : err,
    );
    return { salvagedMessages: 0 };
  }
};
