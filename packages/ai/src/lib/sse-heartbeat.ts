/**
 * Keep a server-sent stream audibly alive while the model says nothing.
 *
 * `Bun.serve` closes a socket that has carried no bytes for `idleTimeout`
 * seconds, and a page build now goes minutes between frames: one `pageReview`
 * builds the project, renders it in a browser and runs a critic over the
 * screenshot, all inside a single tool call. So a turn has to emit something
 * on its own account, or the connection dies under it — and a client
 * disconnect ABORTS the turn, so the work is lost rather than merely unseen.
 *
 * ## Why this is not a TransformStream
 *
 * It was, and the interval never fired. The old shape started a `setInterval`
 * inside `start(controller)` and enqueued from it, with an empty `catch`
 * around the enqueue "in case the controller is closed". Measured 2026-09-06
 * on a raw stream of 656 frames: exactly ONE ping, the one `start()` emits
 * immediately. Every later tick was swallowed. Four page builds in a row then
 * died between 90 and 150 seconds with "the socket connection was closed
 * unexpectedly", while the server carried on — Langfuse recorded thirty-two
 * model calls the caller never saw, and a build fourteen steps in left no page
 * behind. The stream had a heartbeat in name only, and a silent `catch` is why
 * nobody noticed for four months.
 *
 * A source-driven reader cannot fail that way. The ping is not a side effect
 * racing the pipeline; it IS the pull, taken whenever the source loses a race
 * against the clock. If the source produces a chunk first, the chunk wins and
 * the timer is cleared; if the clock wins, a ping goes out and the same read
 * stays pending for the next pull. Nothing is dropped and nothing is
 * duplicated.
 */

/** The clock won this pull. A symbol so a `null` chunk could never be mistaken for it. */
const TICK: unique symbol = Symbol("heartbeat-tick");

export const withHeartbeat = <T>(
  source: ReadableStream<T>,
  intervalMs: number,
  encodePing: () => T,
): ReadableStream<T> => {
  const reader = source.getReader();
  /**
   * The read in flight, kept ACROSS pulls. A `reader.read()` that lost the
   * race is still going to resolve, and starting a second one would drop
   * whatever the first returns.
   */
  let pending: ReturnType<typeof reader.read> | null = null;

  return new ReadableStream<T>({
    // Before the model has produced anything, the preamble (context loading,
    // compaction) is already dead air on the wire.
    start(controller) {
      controller.enqueue(encodePing());
    },

    async pull(controller) {
      pending ??= reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<typeof TICK>((resolve) => {
        timer = setTimeout(() => resolve(TICK), intervalMs);
      });

      const result = await Promise.race([pending, tick]);
      // Whoever won, the timer has no further use — an uncleared one keeps the
      // event loop alive past the end of the response.
      if (timer !== undefined) clearTimeout(timer);

      if (result === TICK) {
        controller.enqueue(encodePing());
        return;
      }

      pending = null;
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },

    cancel(reason: unknown) {
      return reader.cancel(reason);
    },
  });
};
