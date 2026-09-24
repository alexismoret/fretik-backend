import db from "../../db";
import { onUploadEvent, type UploadEvent } from "../../lib/upload-events";
import { type SseStream, streamStatusEvents } from "../sse-utils";

/**
 * Retrieves the current upload progress status of a team's document.
 * Returns the document's status and error message if applicable, or
 * `undefined` when the team has no such document — the route answers 404 on
 * that before it opens the stream, since the event bus below is keyed by the
 * document id alone and would relay any team's progress.
 */
export const getUploadProgress = async (params: {
  documentId: string;
  teamId: string;
}) => {
  const document = await db.query.documents.findFirst({
    columns: { status: true, errorMessage: true },
    where: { id: params.documentId, teamId: params.teamId },
  });

  return document;
};

const isTerminalUploadStatus = (status: string): boolean =>
  status === "ready" || status === "error";

/**
 * Streams upload progress events for a document via SSE.
 *
 * Thin wrapper over `streamStatusEvents` — the shared helper owns the
 * Hono+Bun-safe streaming lifecycle (awaited writes, heartbeat, no
 * post-terminal return, listener cleanup). See `sse-utils.ts` for the
 * full rationale on why we can't simply return after the `ready`/`error`
 * event.
 */
export const streamUploadProgress = async (params: {
  documentId: string;
  teamId: string;
  stream: SseStream;
}): Promise<void> => {
  const { documentId, teamId, stream } = params;
  await streamStatusEvents<UploadEvent>({
    stream,
    initialMessages: async () => {
      const document = await getUploadProgress({ documentId, teamId });
      if (!document) {
        return { messages: [], terminated: false };
      }
      return {
        messages: [
          {
            event: document.status,
            data: JSON.stringify({
              documentId,
              status: document.status,
              error: document.errorMessage,
            }),
          },
        ],
        terminated: isTerminalUploadStatus(document.status),
      };
    },
    subscribe: (onEvent) => onUploadEvent(documentId, onEvent),
    mapEvent: (event) => ({
      message: {
        event: event.status,
        data: JSON.stringify({
          documentId: event.documentId,
          status: event.status,
          error: event.error,
        }),
      },
      terminal: isTerminalUploadStatus(event.status),
    }),
  });
};
