/**
 * Shared helper for DB-status-driven SSE streams (upload progress,
 * extraction progress, any future per-entity progress we add).
 *
 * Rationale
 * ---------
 * Hono's `streamSSE` on Bun has two footguns that produce
 * `ERR_INCOMPLETE_CHUNKED_ENCODING` on the browser side:
 *   1. `stream.writeSSE` returns a Promise that MUST be awaited — an
 *      un-awaited write can still be buffered when Hono closes the
 *      underlying ReadableStream.
 *   2. Returning from the streamSSE callback triggers Hono's internal
 *      `finally` which closes the HTTP response BEFORE the chunked
 *      terminator is flushed. See honojs/hono#3540, #2993.
 *
 * The workaround pattern is: never return from the callback after a
 * terminal event. Keep emitting pings until the client disconnects
 * (`stream.aborted`) or a safety cap expires. This file encapsulates
 * that pattern once so upload/extraction/future progress streams can
 * share the correct implementation and can't diverge.
 *
 * Safety net
 * ----------
 * Heartbeat pings every `heartbeatMs` keep the connection above Bun's
 * `idleTimeout` (30s by default). If the browser never disconnects
 * (laptop sleep, unclean tab close, broken network), pings keep
 * resetting idleTimeout forever — so we also enforce a hard
 * `postTerminalCapMs` cap after the terminal event. Past that cap we
 * return cleanly; any remaining data queued by the server will only be
 * a ping (not a payload), so `ERR_INCOMPLETE_CHUNKED_ENCODING` after
 * the cap is acceptable (the browser already got all the meaningful
 * events).
 */

export interface SseMessage {
  event: string;
  data: string;
}

export interface SseStream {
  writeSSE: (data: SseMessage) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  aborted: boolean;
}

export interface StreamStatusEventsOptions<TEvent> {
  stream: SseStream;
  /**
   * Called once on connect. Returns the SSE messages to replay (e.g.
   * existing steps) + whether the initial DB state is already terminal.
   * When `terminated` is true, the helper skips `subscribe()` entirely
   * and goes straight to the post-terminal heartbeat loop (with cap).
   */
  initialMessages: () => Promise<{
    messages: SseMessage[];
    terminated: boolean;
  }>;
  /**
   * Subscribes to the upstream EventEmitter for this entity. Returns a
   * cleanup function that removes the listener. Guaranteed to be called
   * in a `finally` even if the stream errors out.
   */
  subscribe: (onEvent: (event: TEvent) => void) => () => void;
  /**
   * Maps a raw EventEmitter event into either an SSE message (optionally
   * marked terminal) or `null` to drop the event silently. Returning
   * `terminal: true` flips the helper into post-terminal heartbeat mode.
   */
  mapEvent: (
    event: TEvent,
  ) => { message: SseMessage; terminal: boolean } | null;
  /** Interval between heartbeat pings. Default 10000ms. */
  heartbeatMs?: number;
  /**
   * Max duration (ms) to keep pinging after the terminal event before
   * forcibly returning. Defaults to 120_000 (2 minutes) — the browser
   * SHOULD have closed the EventSource well before that on receipt of
   * the terminal event.
   */
  postTerminalCapMs?: number;
  /** SSE event name used for heartbeat pings. Default "ping". */
  heartbeatEventName?: string;
}

/**
 * Runs the full SSE status-stream lifecycle. Returns only when the
 * client disconnects OR the post-terminal cap expires.
 */
export const streamStatusEvents = async <TEvent>(
  options: StreamStatusEventsOptions<TEvent>,
): Promise<void> => {
  const {
    stream,
    initialMessages,
    subscribe,
    mapEvent,
    heartbeatMs = 10_000,
    postTerminalCapMs = 120_000,
    heartbeatEventName = "ping",
  } = options;

  // 1. Replay initial state. Every write is awaited so nothing lingers
  //    in the TCP buffer when the function returns.
  const initial = await initialMessages();
  for (const msg of initial.messages) {
    // oxlint-disable-next-line no-await-in-loop
    await stream.writeSSE(msg);
  }

  let terminated = initial.terminated;
  let terminatedAt = terminated ? Date.now() : 0;

  // 2. Bridge the EventEmitter callback to an awaitable queue so the
  //    main loop can await each write in order. Raising the listener
  //    out of the sync callback avoids the race where an un-awaited
  //    write was fired from inside the emitter.
  const queue: TEvent[] = [];
  let resolveNext: (() => void) | null = null;

  const cleanup = subscribe((event) => {
    queue.push(event);
    if (resolveNext) {
      const fn = resolveNext;
      resolveNext = null;
      fn();
    }
  });

  const waitForEvent = (): Promise<TEvent | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
    return new Promise((resolve) => {
      resolveNext = () => resolve(queue.shift() ?? null);
    });
  };

  // 3. Main loop. Returns when the client disconnects or the
  //    post-terminal cap expires.
  try {
    while (!stream.aborted) {
      if (terminated && Date.now() - terminatedAt >= postTerminalCapMs) {
        // Safety cap — the browser never closed the EventSource. We've
        // sent the terminal event, pinged for `postTerminalCapMs`, done
        // our duty. Return so the stream is released.
        return;
      }

      const heartbeat = stream
        .sleep(heartbeatMs)
        .then(() => "heartbeat" as const);
      // oxlint-disable-next-line no-await-in-loop
      const next = await Promise.race([heartbeat, waitForEvent()]);

      if (next === "heartbeat") {
        // oxlint-disable-next-line no-await-in-loop
        await stream.writeSSE({ event: heartbeatEventName, data: "ping" });
        continue;
      }

      if (!next) continue;
      if (terminated) continue; // drop post-terminal events

      const mapped = mapEvent(next);
      if (!mapped) continue;

      // oxlint-disable-next-line no-await-in-loop
      await stream.writeSSE(mapped.message);

      if (mapped.terminal) {
        terminated = true;
        terminatedAt = Date.now();
      }
    }
  } finally {
    cleanup();
  }
};
