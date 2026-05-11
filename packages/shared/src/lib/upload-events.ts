import { EventEmitter } from "events";
import type { documentStatusEnum } from "../db/schema";

export interface UploadEvent {
  documentId: string;
  status: (typeof documentStatusEnum.enumValues)[number];
  error?: string;
}

/**
 * Singleton EventEmitter for document upload processing events.
 * Used to bridge background processing with SSE streams.
 *
 * Events are emitted per-document: `document:{documentId}`
 */
const uploadEmitter = new EventEmitter();
uploadEmitter.setMaxListeners(100);

export const emitUploadEvent = (event: UploadEvent): void => {
  uploadEmitter.emit(`document:${event.documentId}`, event);
};

/**
 * Listens for upload events for a specific document.
 * Returns a cleanup function to remove the listener.
 */
export const onUploadEvent = (
  documentId: string,
  callback: (event: UploadEvent) => void,
): (() => void) => {
  const eventName = `document:${documentId}`;
  uploadEmitter.on(eventName, callback);
  return () => {
    uploadEmitter.removeListener(eventName, callback);
  };
};
