import type { documentStatusEnum } from "../db/schema";
import { redis } from "./redis";
import { subscribeChannel } from "./redis-subscriber";

export interface UploadEvent {
  documentId: string;
  status: (typeof documentStatusEnum.enumValues)[number];
  error?: string;
}

/**
 * Document upload progress events, fanned out over Redis pub/sub so they
 * cross replicas: the BullMQ worker that processes the document and the
 * API replica holding the client's SSE connection are almost never the
 * same process. Channel is per-document: `upload-events:{documentId}`.
 *
 * The SSE handler re-reads the authoritative status from the DB on
 * connect, so an event published in the (sub-millisecond) window before
 * the subscriber's SUBSCRIBE lands is not a correctness problem.
 */
const channel = (documentId: string): string => `upload-events:${documentId}`;

export const emitUploadEvent = (event: UploadEvent): void => {
  // Fire-and-forget publish — progress is advisory; the DB row is the
  // source of truth. Errors are logged by the redis client's error handler.
  void redis.publish(channel(event.documentId), JSON.stringify(event));
};

/**
 * Listens for upload events for a specific document over the shared
 * subscriber connection. Returns a synchronous cleanup function.
 */
export const onUploadEvent = (
  documentId: string,
  callback: (event: UploadEvent) => void,
): (() => void) =>
  subscribeChannel(channel(documentId), (payload) => {
    try {
      const event: UploadEvent = JSON.parse(payload);
      callback(event);
    } catch (err) {
      console.warn(
        "[upload-events] failed to parse payload:",
        err instanceof Error ? err.message : err,
      );
    }
  });
