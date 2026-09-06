/**
 * The bridge between a fan-out subscription (Redis pub/sub) and one viewer's
 * SSE connection.
 *
 * Every SSE write has to be awaited in order (the Bun chunked-encoding
 * footgun), while events arrive whenever they arrive. So they land in a queue
 * the writer drains, and the writer blocks on "an event, or the keep-alive
 * deadline, whichever comes first".
 *
 * The shape is the whole point, because the obvious shape LOSES events. The
 * first version raced `Promise.race(heartbeat, waitForEvent())`, where the
 * waiter CONSUMED from the queue: an event that arrived just as the heartbeat
 * won was shifted out of the queue into a promise nobody read. A dropped
 * `turn-started` meant a viewer never attached to the running turn; a dropped
 * `turn-ended` left its composer stuck on Stop until the page was reloaded.
 *
 * Hence the two rules encoded here: the queue is drained by the WRITER and by
 * nobody else, and waiting never touches it — `waitForEventOrHeartbeat` only
 * reports which came first, so an event is still in the queue whatever the
 * race decided.
 *
 * Pub/sub has no replay, so anything published before the subscription exists
 * is gone. Subscribe (and start pushing here) BEFORE writing any initial
 * snapshot, not after: the snapshot's own round trips are exactly the window
 * in which a turn ends.
 */
export interface SseEventQueue {
  /** Hand an arriving payload to the writer. Never blocks. */
  push: (payload: string) => void;
  /** Next payload to write, oldest first — `undefined` when drained. */
  take: () => string | undefined;
  /**
   * Resolves `"event"` as soon as the queue is (or becomes) non-empty, and
   * `"heartbeat"` after `heartbeatMs` of silence. Never consumes.
   */
  waitForEventOrHeartbeat: () => Promise<"event" | "heartbeat">;
}

export const createSseEventQueue = (heartbeatMs: number): SseEventQueue => {
  const queue: string[] = [];
  let signalEvent: (() => void) | null = null;

  return {
    push: (payload: string): void => {
      queue.push(payload);
      signalEvent?.();
      signalEvent = null;
    },

    take: (): string | undefined => queue.shift(),

    waitForEventOrHeartbeat: (): Promise<"event" | "heartbeat"> =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve("event");
          return;
        }
        const timer = setTimeout(() => {
          signalEvent = null;
          resolve("heartbeat");
        }, heartbeatMs);
        signalEvent = () => {
          clearTimeout(timer);
          resolve("event");
        };
      }),
  };
};
