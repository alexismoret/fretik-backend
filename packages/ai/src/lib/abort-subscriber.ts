import { redis } from "@fretik/shared/lib/redis";

/**
 * Subscribe a fresh Redis connection to `channel` and fire `onAbort` on any
 * message — the shared "user pressed Stop" plumbing for the chatbot (keyed by
 * resumable stream id) and the workflow (keyed by run id). A dedicated
 * connection per turn keeps the pub/sub subscribe off the shared command
 * client. Returns a `release` to `quit()` the connection in the turn's
 * `finally` / `onFinish`; cleanup failures are swallowed (best-effort).
 */
export const subscribeAbort = async (
  channel: string,
  onAbort: () => void,
): Promise<{ release: () => Promise<void> }> => {
  const subscriber = redis.duplicate();
  await subscriber.subscribe(channel);
  subscriber.on("message", onAbort);
  return {
    release: async () => {
      try {
        await subscriber.quit();
      } catch (err) {
        console.warn("[abort-subscriber] cleanup failed", err);
      }
    },
  };
};
