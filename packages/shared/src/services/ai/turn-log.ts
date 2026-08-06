import { redis } from "../../lib/redis";
import { subscribeChannel } from "../../lib/redis-subscriber";

/**
 * Per-turn append-only event log in a Redis Stream — the transport core of
 * chatbot streaming.
 *
 * One turn = one Redis Stream keyed by the turn's `streamId` (the claim
 * uuid in `ai_conversations.active_stream_id`). The producer XADDs one
 * entry per AI SDK `UIMessageChunk` (serialized JSON, post-scrub); every
 * consumer — the initiating POST, a reloading tab, a collaborative viewer
 * — reads the SAME log back with `XRANGE` batches and blocks on a tiny
 * pub/sub wakeup between batches. Redis entry IDs (`<ms>-<n>`) double as
 * resume cursors: the SSE `id:` field carries them to the client, and a
 * reconnect resumes exclusively after the last seen id. Replay and live
 * tail are the same operation, so there is no replay→live gap, and a slow
 * consumer only slows its own XRANGE loop.
 *
 * This replaces `resumable-stream`, whose buffer lived in the producing
 * process (unresumable across replicas/restarts) and whose whole-buffer
 * replay went out as a single Redis PUBLISH — past the pubsub
 * client-output-buffer limit, Redis killed the replica's shared subscriber
 * connection and froze every attached viewer.
 *
 * Producer liveness rides the log itself: a transient `data-ping` entry is
 * appended every `TURN_LOG_PING_MS` while nothing else is written, so the
 * newest entry id is always a fresh producer heartbeat. A log whose last
 * entry is older than `TURN_LOG_ORPHAN_MS` with no end marker means the
 * producing process died — consumers close, and the resume endpoint clears
 * the conversation's active-stream slot.
 */

const logKey = (streamId: string): string => `fretik-chatbot-turn:${streamId}`;
const wakeChannel = (streamId: string): string =>
  `fretik-chatbot-turn-wake:${streamId}`;

/** Producer heartbeat cadence while no chunk is being written. */
export const TURN_LOG_PING_MS = 5_000;
/** Last-entry age past which a not-ended log is considered orphaned. */
export const TURN_LOG_ORPHAN_MS = 20_000;
/** Read batch size for the XRANGE loop. */
const READ_BATCH = 256;
/** Wakeup-miss backstop: re-poll even without a wake signal. */
const WAKE_POLL_MS = 10_000;
/**
 * Safety valve on entries per turn (`MAXLEN ~`). A monster turn is a few
 * thousand entries; hitting this means a runaway loop, and trimming the
 * oldest entries only degrades late replays, never the live tail.
 */
const MAX_ENTRIES = 100_000;
/** Defensive TTL while the turn runs (covers a crashed producer). */
const OPEN_TTL_S = 6 * 60 * 60;
/** Retention after the end marker (covers any client mid-replay). */
const ENDED_TTL_S = 15 * 60;

const DONE_FRAME = "data: [DONE]\n\n";

const entryTimestampMs = (entryId: string): number => {
  const ms = Number.parseInt(entryId.split("-")[0] ?? "", 10);
  return Number.isFinite(ms) ? ms : 0;
};

const encodePingChunk = (): string =>
  JSON.stringify({
    type: "data-ping",
    data: { t: Date.now() },
    transient: true,
  });

/**
 * Create the log the moment the turn's slot is claimed — BEFORE any turn
 * setup. Guarantees a viewer invited by `turn-started` always finds a log
 * to attach to (the old buffer registered seconds into the turn, and early
 * attachers 204'd onto a frozen transcript).
 */
export const openTurnLog = async (streamId: string): Promise<void> => {
  const key = logKey(streamId);
  await redis
    .pipeline()
    .xadd(key, "MAXLEN", "~", MAX_ENTRIES, "*", "m", "open")
    .expire(key, OPEN_TTL_S)
    .exec();
};

/**
 * Append one serialized `UIMessageChunk` and wake blocked readers. The
 * wake payload carries no data (readers re-XRANGE), so it can never trip
 * Redis' pubsub output-buffer limits regardless of turn size.
 */
const appendEntry = async (
  streamId: string,
  fields: string[],
): Promise<void> => {
  const key = logKey(streamId);
  await redis
    .pipeline()
    .xadd(key, "MAXLEN", "~", MAX_ENTRIES, "*", ...fields)
    .publish(wakeChannel(streamId), "1")
    .exec();
};

/**
 * Terminal marker. Readers emit the SSE `[DONE]` terminator when they
 * reach it. Shrinks the TTL to the post-turn retention window — history
 * (incrementally persisted + `onFinish`) is the source of truth afterwards.
 */
export const endTurnLog = async (
  streamId: string,
  reason: "finish" | "error",
): Promise<void> => {
  const key = logKey(streamId);
  await redis
    .pipeline()
    .xadd(key, "MAXLEN", "~", MAX_ENTRIES, "*", "m", "end", "r", reason)
    .expire(key, ENDED_TTL_S)
    .publish(wakeChannel(streamId), "1")
    .exec();
};

/**
 * Drive a turn's chunk stream into its log. This is the ONLY consumer of
 * the SDK stream — it always drains to completion so the agent loop and
 * its `onFinish` (persistence, slot release, `turn-ended`) run no matter
 * how many HTTP consumers are attached, or none.
 *
 * Degraded mode: if Redis fails mid-turn we keep draining (generation and
 * final persistence must complete); viewers stall until they reconnect
 * and fall back to history. Logged once, not per chunk.
 */
export const pumpChunksToTurnLog = async (
  streamId: string,
  chunks: ReadableStream<unknown>,
): Promise<void> => {
  let lastWriteAt = Date.now();
  let degradedLogged = false;
  const ping = setInterval(() => {
    if (Date.now() - lastWriteAt < TURN_LOG_PING_MS - 500) return;
    lastWriteAt = Date.now();
    appendEntry(streamId, ["d", encodePingChunk()]).catch(() => {
      // Degradation already surfaced by the data path below.
    });
  }, TURN_LOG_PING_MS);

  const reader = chunks.getReader();
  try {
    /* oxlint-disable no-await-in-loop -- entries must land in stream order */
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastWriteAt = Date.now();
      try {
        await appendEntry(streamId, ["d", JSON.stringify(value)]);
      } catch (err) {
        if (!degradedLogged) {
          degradedLogged = true;
          console.error(
            `[turn-log] append failed for ${streamId} — continuing degraded (viewers stall, persistence unaffected):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    /* oxlint-enable no-await-in-loop */
    await endTurnLog(streamId, "finish");
  } catch (err) {
    console.error(
      `[turn-log] pump failed for ${streamId}:`,
      err instanceof Error ? err.message : err,
    );
    await endTurnLog(streamId, "error").catch(() => undefined);
  } finally {
    clearInterval(ping);
    reader.releaseLock();
  }
};

export interface TurnLogStatus {
  exists: boolean;
  ended: boolean;
  lastEntryMs: number;
}

/**
 * Snapshot of a log's tail: whether it exists, whether the end marker is
 * written (always the final entry), and the newest entry's timestamp —
 * which, thanks to the producer ping, is a live-producer heartbeat.
 */
export const getTurnLogStatus = async (
  streamId: string,
): Promise<TurnLogStatus> => {
  const last = await redis.xrevrange(logKey(streamId), "+", "-", "COUNT", 1);
  const entry = last[0];
  if (!entry) return { exists: false, ended: false, lastEntryMs: 0 };
  const [entryId, fields] = entry;
  let ended = false;
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === "m" && fields[i + 1] === "end") ended = true;
  }
  return { exists: true, ended, lastEntryMs: entryTimestampMs(entryId) };
};

/**
 * Serve a turn log as an SSE byte stream, starting strictly AFTER
 * `cursor` ("0-0" = full, structurally complete replay). Every data frame
 * carries `id: <redis-entry-id>` so the client can resume from its last
 * received frame with zero duplication. Ends with `data: [DONE]` on the
 * end marker; closes WITHOUT it when the producer is detected dead, which
 * clients treat as a drop → reconnect → orphan-cleared 204 → history.
 */
export const readTurnLogAsSse = (
  streamId: string,
  cursor: string,
): ReadableStream<Uint8Array> => {
  const key = logKey(streamId);
  const encoder = new TextEncoder();
  let lastId = cursor;
  let wake: (() => void) | null = null;
  let woken = false;
  let cancelled = false;
  const off = subscribeChannel(wakeChannel(streamId), () => {
    woken = true;
    wake?.();
    wake = null;
  });

  const waitForWake = (): Promise<void> =>
    new Promise((resolve) => {
      if (woken || cancelled) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, WAKE_POLL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  // `pull`-based so each viewer gets real backpressure: one XRANGE batch
  // is enqueued per pull, and the runtime only re-pulls once the consumer
  // drained below the high-water mark. A slow tab bounds its own memory
  // to ~one batch and never slows the producer or other viewers.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        /* oxlint-disable no-await-in-loop -- cursor loop is inherently serial */
        while (!cancelled) {
          woken = false;
          const batch = await redis.xrange(
            key,
            `(${lastId}`,
            "+",
            "COUNT",
            READ_BATCH,
          );
          if (batch.length > 0) {
            for (const [entryId, fields] of batch) {
              lastId = entryId;
              for (let i = 0; i < fields.length - 1; i += 2) {
                if (fields[i] === "d") {
                  controller.enqueue(
                    encoder.encode(
                      `id: ${entryId}\ndata: ${fields[i + 1] ?? ""}\n\n`,
                    ),
                  );
                } else if (fields[i] === "m" && fields[i + 1] === "end") {
                  controller.enqueue(encoder.encode(DONE_FRAME));
                  controller.close();
                  off();
                  return;
                }
              }
            }
            // Batch delivered — yield to backpressure; pull re-runs when
            // the consumer has drained.
            return;
          }
          if (woken) continue; // a write landed while we were querying
          // Orphan check before blocking: a live producer pings every 5s,
          // so a stale tail with no end marker means the process died.
          const tailMs =
            lastId === "0-0" ? Date.now() : entryTimestampMs(lastId);
          if (Date.now() - tailMs > TURN_LOG_ORPHAN_MS) {
            controller.close();
            off();
            return;
          }
          await waitForWake();
        }
        /* oxlint-enable no-await-in-loop */
      } catch (err) {
        off();
        if (!cancelled) {
          console.error(
            `[turn-log] read failed for ${streamId}:`,
            err instanceof Error ? err.message : err,
          );
          controller.error(err);
        }
      }
    },
    cancel() {
      cancelled = true;
      woken = true;
      wake?.();
      wake = null;
      off();
    },
  });
};
