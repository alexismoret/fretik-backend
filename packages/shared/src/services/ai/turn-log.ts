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
 * Producer liveness is read from the log's CONTENT (`isTurnLogOrphan`):
 * every entry carries how many tool calls are in flight, and the silence a
 * turn is owed depends on it — a tool executing is expected silence, a
 * generating model is not. The transient `data-ping` heartbeat remains as
 * a freshness fast-path, but nothing depends on it firing: it measurably
 * starves when the event loop is loaded. A log judged orphaned is DRAINED
 * into history (`turn-drain.ts`), then its slot is cleared.
 */

const logKey = (streamId: string): string => `fretik-chatbot-turn:${streamId}`;
const wakeChannel = (streamId: string): string =>
  `fretik-chatbot-turn-wake:${streamId}`;

/** Producer heartbeat cadence while no chunk is being written. */
export const TURN_LOG_PING_MS = 5_000;
/**
 * Orphan deadlines — how long a not-ended log may go silent before its
 * producer is considered dead. TWO deadlines, chosen by what the log says
 * the turn is doing, because the two silences mean different things:
 *
 *  - `TOOL`: the newest entry says one or more tool calls are executing
 *    (`pendingTools > 0`). Silence is the EXPECTED state — a `buildPage`
 *    runs for minutes and streams nothing while it does. The deadline only
 *    has to catch a truly hung tool, so it sits above the slowest
 *    legitimate tool (the giga-page build budget is 240s).
 *  - `IDLE`: the model is generating; deltas normally land every few
 *    seconds, and the slow case is first-token latency on a large prompt.
 *
 * Why so much larger than the ping cadence: liveness must never DEPEND on
 * the ping. Measured 2026-08-21 on the loaded dev service: the 5s ping
 * interval fired minutes apart (timer starvation; pings landed only when
 * other Redis activity woke the loop), so every tool call slower than the
 * old 20s single deadline had its live turn declared dead — viewers
 * closed, the slot was cleared, and the finished work was never shown.
 * The ping remains as a freshness fast-path when the event loop is
 * healthy; the deadlines are sized to stay correct when it is not.
 */
export const TURN_LOG_IDLE_ORPHAN_MS = 120_000;
export const TURN_LOG_TOOL_ORPHAN_MS = 600_000;
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
 * How many tool calls are executing after this chunk, given how many were
 * executing before it. Pure — this is the whole liveness model, so it is
 * exported and pinned by tests.
 *
 * A call opens at `tool-input-available` (the input is complete, `execute`
 * starts — the moment the wire goes quiet) and closes when its output or
 * error lands. `tool-input-start`/`-delta` are NOT openings: the model is
 * still streaming the arguments, so the wire is demonstrably alive.
 */
export const pendingToolsAfter = (chunk: unknown, current: number): number => {
  if (typeof chunk !== "object" || chunk === null) return current;
  const type = Reflect.get(chunk, "type");
  if (type === "tool-input-available") return current + 1;
  if (type === "tool-output-available" || type === "tool-output-error") {
    return Math.max(0, current - 1);
  }
  return current;
};

/**
 * The single orphan rule, shared by every consumer (chat resume, workflow
 * transcript, the sweeper, the SSE reader): a log with an end marker is
 * never an orphan, and a silent one is judged against the deadline for
 * what its tail says the turn is doing.
 */
export const isTurnLogOrphan = (
  status: Pick<TurnLogStatus, "ended" | "lastEntryMs" | "pendingTools">,
  nowMs: number,
): boolean => {
  if (status.ended) return false;
  const deadline =
    status.pendingTools > 0 ? TURN_LOG_TOOL_ORPHAN_MS : TURN_LOG_IDLE_ORPHAN_MS;
  return nowMs - status.lastEntryMs > deadline;
};

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
  // Tools in flight, stamped as field `p` on EVERY entry (pings included).
  // This is what liveness is read from: the ping timer is advisory only —
  // measured starving for minutes on the loaded service — so the tail of
  // the log has to say, on its own, whether silence is a tool executing or
  // a dead producer.
  let pendingTools = 0;
  const ping = setInterval(() => {
    if (Date.now() - lastWriteAt < TURN_LOG_PING_MS - 500) return;
    lastWriteAt = Date.now();
    appendEntry(streamId, [
      "d",
      encodePingChunk(),
      "p",
      String(pendingTools),
    ]).catch(() => {
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
      pendingTools = pendingToolsAfter(value, pendingTools);
      try {
        await appendEntry(streamId, [
          "d",
          JSON.stringify(value),
          "p",
          String(pendingTools),
        ]);
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
  /** Tool calls executing as of the newest entry (field `p`). Entries
   * written before the field existed report 0 — they degrade to the idle
   * deadline, never to a longer one. */
  pendingTools: number;
}

/** The `p` field of one entry's field list, 0 when absent or malformed. */
const pendingToolsOf = (fields: string[]): number => {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === "p") {
      const parsed = Number.parseInt(fields[i + 1] ?? "", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
  }
  return 0;
};

/**
 * Snapshot of a log's tail: whether it exists, whether the end marker is
 * written (always the final entry), the newest entry's timestamp, and how
 * many tool calls that entry says are in flight. Together with
 * `isTurnLogOrphan` this is the liveness verdict — derived entirely from
 * the log's CONTENT, never from trusting that a producer-side timer got
 * scheduled.
 */
export const getTurnLogStatus = async (
  streamId: string,
): Promise<TurnLogStatus> => {
  const last = await redis.xrevrange(logKey(streamId), "+", "-", "COUNT", 1);
  const entry = last[0];
  if (!entry) {
    return { exists: false, ended: false, lastEntryMs: 0, pendingTools: 0 };
  }
  const [entryId, fields] = entry;
  let ended = false;
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === "m" && fields[i + 1] === "end") ended = true;
  }
  return {
    exists: true,
    ended,
    lastEntryMs: entryTimestampMs(entryId),
    pendingTools: pendingToolsOf(fields),
  };
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
  // Tools in flight as of the last entry SEEN — decides which orphan
  // deadline applies while we block. Seeded lazily from the log's tail on
  // the first pull: a viewer attaching mid-tool-call has forwarded nothing
  // yet, and judging that silence by the idle deadline would close a
  // stream whose turn is simply executing a slow tool.
  let pendingTools = 0;
  let seeded = false;
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
        if (!seeded) {
          seeded = true;
          const tail = await redis.xrevrange(key, "+", "-", "COUNT", 1);
          if (tail[0]) pendingTools = pendingToolsOf(tail[0][1]);
        }
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
              pendingTools = pendingToolsOf(fields);
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
          // Orphan check before blocking — the deadline depends on what
          // the tail says the turn is doing (a tool executing is EXPECTED
          // silence), and never assumes the ping timer fired: measured
          // 2026-08-21, an in-process page render starved every timer for
          // minutes while the turn was alive and productive.
          const tailMs =
            lastId === "0-0" ? Date.now() : entryTimestampMs(lastId);
          if (
            isTurnLogOrphan(
              { ended: false, lastEntryMs: tailMs, pendingTools },
              Date.now(),
            )
          ) {
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
