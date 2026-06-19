import { redis } from "./redis";

/**
 * Shared Redis pub/sub subscriber, multiplexed over a SINGLE connection
 * per replica.
 *
 * ioredis `SUBSCRIBE` locks a connection into subscriber mode (regular
 * commands stop working on it), so every pub/sub consumer needs a
 * connection separate from the main `redis` client. The naive pattern —
 * `redis.duplicate()` per SSE viewer — opens one TCP connection per
 * viewer per replica, so the connection count drifts with load and can
 * exhaust a small Redis instance.
 *
 * This module collapses that to ONE duplicated connection per replica.
 * Listeners are tracked in-process per channel; the underlying Redis
 * `SUBSCRIBE`/`UNSUBSCRIBE` is ref-counted (subscribe on the first
 * listener of a channel, unsubscribe on the last). The connection itself
 * stays alive for the process lifetime and ioredis re-subscribes to all
 * active channels automatically after a reconnect.
 *
 * Registration is synchronous (the listener lands in the in-memory map
 * immediately and `subscribeChannel` returns a sync cleanup); the Redis
 * `SUBSCRIBE` is issued in the background. A message published in the
 * window before `SUBSCRIBE` lands is therefore not delivered — every
 * caller tolerates this: upload progress re-reads the authoritative
 * status from the DB on connect, and collaborative presence/typing
 * re-syncs on the next event.
 */

type ChannelListener = (payload: string) => void;

const listeners = new Map<string, Set<ChannelListener>>();

let subscriber: ReturnType<typeof redis.duplicate> | null = null;

const getSubscriber = (): ReturnType<typeof redis.duplicate> => {
  if (subscriber) return subscriber;

  const client = redis.duplicate();

  client.on("message", (channel: string, payload: string) => {
    const set = listeners.get(channel);
    if (!set) return;
    // Snapshot to an array so a listener that unsubscribes itself during
    // dispatch doesn't mutate the set we're iterating.
    for (const listener of [...set]) {
      listener(payload);
    }
  });

  client.on("error", (err: unknown) => {
    console.error(
      "[redis-subscriber] connection error:",
      err instanceof Error ? err.message : err,
    );
  });
  client.on("end", () => {
    console.warn("[redis-subscriber] connection ended");
  });
  client.on("reconnecting", (delayMs: unknown) => {
    const delay =
      typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : "?";
    console.warn(`[redis-subscriber] reconnecting in ${delay.toString()}ms`);
  });

  subscriber = client;
  return client;
};

/**
 * Register a listener on a pub/sub channel over the shared subscriber.
 * Returns a synchronous cleanup that removes the listener (and issues
 * `UNSUBSCRIBE` when it was the last one for that channel).
 */
export const subscribeChannel = (
  channel: string,
  listener: ChannelListener,
): (() => void) => {
  const client = getSubscriber();

  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    // First listener for this channel — issue the Redis SUBSCRIBE in the
    // background. ioredis queues the command until the socket is ready.
    client.subscribe(channel).catch((err: unknown) => {
      console.error(
        `[redis-subscriber] SUBSCRIBE ${channel} failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  set.add(listener);

  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    const current = listeners.get(channel);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(channel);
      client.unsubscribe(channel).catch((err: unknown) => {
        console.error(
          `[redis-subscriber] UNSUBSCRIBE ${channel} failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  };
};
