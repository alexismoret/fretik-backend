import Redis from "ioredis";
import type { ResumableStreamContext } from "resumable-stream/ioredis";
import { createResumableStreamContext } from "resumable-stream/ioredis";

/**
 * Singleton Redis-backed resumable stream context for the chatbot.
 *
 * The `resumable-stream` package buffers the SSE output in Redis so a
 * second client can tee the same stream (reconnection after a tab close
 * or network drop). It needs two dedicated ioredis connections — a
 * publisher and a subscriber — separate from the main `@fretik/shared`
 * client because `SUBSCRIBE` puts the connection in a state where
 * regular commands no longer work.
 *
 * `waitUntil: null` is the correct choice for a long-lived Bun server:
 * we never suspend mid-function like a serverless edge worker, so the
 * library doesn't need a lifetime-extension hook.
 *
 * Lazy-instantiated on first access to avoid connecting to Redis during
 * module import (and to survive tests that don't need it).
 *
 * **Error observability (Sprint A — plan §3.4).** Both ioredis
 * connections used to be created without `error` listeners attached.
 * `maxRetriesPerRequest: null` made the client survive transient
 * disconnects, but a permanent failure on either socket would surface
 * silently — the SUBSCRIBE side in particular can drift out of sync
 * with the publisher and a stuck stream becomes invisible to ops.
 * We now log every `error`, `end`, and `reconnecting` event with a
 * structured prefix so disconnect anomalies show up in container
 * logs without standing up a metrics pipeline.
 */
let cachedContext: ResumableStreamContext | null = null;

const assertRedisUrl = (): string => {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is required for resumable-stream (@fretik/ai chatbot)",
    );
  }
  return url;
};

const attachConnectionDiagnostics = (
  client: Redis,
  role: "publisher" | "subscriber",
): void => {
  client.on("error", (err: unknown) => {
    console.error(
      `[resumable-stream:${role}] redis error:`,
      err instanceof Error ? err.message : err,
    );
  });
  client.on("end", () => {
    console.warn(`[resumable-stream:${role}] redis connection ended`);
  });
  client.on("reconnecting", (delayMs: unknown) => {
    const delay =
      typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : "?";
    console.warn(
      `[resumable-stream:${role}] redis reconnecting in ${delay.toString()}ms`,
    );
  });
};

export const getResumableStreamContext = (): ResumableStreamContext => {
  if (cachedContext) return cachedContext;

  const url = assertRedisUrl();
  const publisher = new Redis(url, { maxRetriesPerRequest: null });
  const subscriber = new Redis(url, { maxRetriesPerRequest: null });

  attachConnectionDiagnostics(publisher, "publisher");
  attachConnectionDiagnostics(subscriber, "subscriber");

  cachedContext = createResumableStreamContext({
    publisher,
    subscriber,
    // Bun server process is long-lived — no need to extend lifetime.
    waitUntil: null,
    keyPrefix: "fretik-chatbot-stream",
  });
  return cachedContext;
};
