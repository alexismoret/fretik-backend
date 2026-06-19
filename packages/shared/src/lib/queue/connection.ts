import Redis from "ioredis";

/**
 * BullMQ Redis connection factory.
 *
 * BullMQ needs different connection semantics for producers and workers,
 * and neither should share the main `@fretik/shared` `redis` client
 * (which is tuned for cache / rate-limit / publish, not blocking queue
 * ops):
 *
 *  - **Producer** (HTTP enqueue path): `maxRetriesPerRequest: 1` +
 *    `enableOfflineQueue: false` so `queue.add()` fails FAST (surfaced as
 *    a 503) when Redis is unreachable, instead of hanging the request.
 *    One shared producer connection is reused by every Queue in a
 *    process — it only issues short, non-blocking commands.
 *
 *  - **Worker**: `maxRetriesPerRequest: null` so the worker waits
 *    patiently through transient blips and keeps consuming forever (BullMQ
 *    THROWS if a Worker connection has any other value). Workers use
 *    blocking commands, so each Worker gets its own dedicated connection.
 *
 * Connection count per replica stays a small constant: one shared
 * producer + one connection per in-process Worker.
 */

const assertRedisUrl = (): string => {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required for BullMQ (queue connections)");
  }
  return url;
};

const attachDiagnostics = (
  client: Redis,
  role: "producer" | "worker",
): void => {
  client.on("error", (err: unknown) => {
    console.error(
      `[queue:${role}] redis error:`,
      err instanceof Error ? err.message : err,
    );
  });
  client.on("reconnecting", (delayMs: unknown) => {
    const delay =
      typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : "?";
    console.warn(`[queue:${role}] redis reconnecting in ${delay.toString()}ms`);
  });
};

let producerConnection: Redis | null = null;

/**
 * Shared, lazily-created producer connection. Fail-fast: an enqueue can't
 * hang forever on a downed Redis — the caller gets an error and can retry.
 */
export const getProducerConnection = (): Redis => {
  if (producerConnection) return producerConnection;
  producerConnection = new Redis(assertRedisUrl(), {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  attachDiagnostics(producerConnection, "producer");
  return producerConnection;
};

/**
 * A fresh dedicated worker connection. Patient (`maxRetriesPerRequest:
 * null`) and required by BullMQ for Workers. Call once per Worker.
 */
export const createWorkerConnection = (): Redis => {
  const client = new Redis(assertRedisUrl(), {
    maxRetriesPerRequest: null,
  });
  attachDiagnostics(client, "worker");
  return client;
};
