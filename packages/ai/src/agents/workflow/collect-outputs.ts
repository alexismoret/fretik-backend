import type { WorkflowRunOutput } from "@fretik/shared/schemas/workflows";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import type { UIMessage } from "ai";

/**
 * Turn a finished run's deliverables into `workflow_runs.outputs` — the
 * first-class "Deliverables" list on the run page. A run produces files by
 * calling `presentFiles`, which mirrors each to the conversation's S3 session
 * folder; here we scan the whole transcript for those tool results and surface
 * them so the run page can render download links WITHOUT opening the transcript
 * (the files are otherwise buried in the headless run conversation).
 *
 * Every file the agent presented is surfaced — if it produced one, it produced
 * it for the user to see. Deduped by path only (a re-presented file is the
 * same deliverable, not a new one).
 *
 * The download URL the run page builds points at the SAME endpoint the chat
 * uses (`/chatbot-files/conversation/:id/files/:name/download?path=`), so no
 * new serving path is introduced — team ownership is checked there via the run
 * conversation's teamId.
 */

const stringField = (obj: object, key: string): string | undefined => {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "string" ? value : undefined;
};

const numberField = (obj: object, key: string): number | undefined => {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "number" ? value : undefined;
};

/**
 * Extract every `presentFiles` deliverable from a run's conversation, deduped
 * by path (last occurrence wins — a re-presented file keeps its latest state).
 *
 * `currentTurnMessages` MUST carry the finishing turn's in-memory messages:
 * the collector runs BEFORE the transaction that persists them, and the
 * common pattern is "produce → present → close the last task" all in the
 * final turn — a DB-only scan would silently drop exactly those deliverables.
 */
export const collectRunOutputs = async (
  conversationId: string,
  currentTurnMessages: UIMessage[] = [],
): Promise<WorkflowRunOutput[]> => {
  const persisted = await getConversationMessages(conversationId);
  // Current-turn messages last so their state wins in the by-path dedup.
  const messages = [...persisted, ...currentTurnMessages];
  const byPath = new Map<string, WorkflowRunOutput>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-presentFiles") continue;
      if (!("output" in part)) continue;
      const output: unknown = part.output;
      if (output === null || typeof output !== "object") continue;
      if (!("files" in output)) continue;
      const files: unknown = output.files;
      if (!Array.isArray(files)) continue;

      for (const fileRaw of files) {
        // `Array.isArray` widens to `any[]`; re-bind to `unknown` and narrow.
        const file: unknown = fileRaw;
        if (file === null || typeof file !== "object") continue;
        const filename = stringField(file, "filename");
        const filePath = stringField(file, "path");
        if (filename === undefined || filePath === undefined) continue;
        const mimeType = stringField(file, "mimeType");
        const sizeBytes = numberField(file, "size");
        byPath.set(filePath, {
          label: filename.slice(0, 120),
          filePath: filePath.slice(0, 500),
          ...(mimeType !== undefined
            ? { mimeType: mimeType.slice(0, 150) }
            : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        });
      }
    }
  }

  return [...byPath.values()];
};
