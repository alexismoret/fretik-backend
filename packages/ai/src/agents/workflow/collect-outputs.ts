import type { WorkflowRunOutput } from "@fretik/shared/schemas/workflows";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { presentedFilesInMessages } from "@fretik/shared/services/chat-files/presented-files";
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
 *
 * The scan itself lives in `@fretik/shared/services/chat-files/presented-files`
 * because the chat's own file panel asks the same question of the same
 * transcript — which files did the agent hand over, as opposed to leave lying
 * around. Two readings of one signal had no business being two parsers.
 */

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
  const presented = presentedFilesInMessages([
    ...persisted,
    ...currentTurnMessages,
  ]);

  return [...presented.values()].map((file) => ({
    label: file.filename.slice(0, 120),
    filePath: file.path.slice(0, 500),
    ...(file.mimeType !== undefined
      ? { mimeType: file.mimeType.slice(0, 150) }
      : {}),
    ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
  }));
};
