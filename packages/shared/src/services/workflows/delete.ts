import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { aiConversations, workflows } from "../../db/schema";
import { deleteSessionFolder } from "../../lib/chatbot-session-storage";
import { badRequest, throwHttpError } from "../../lib/errors";
import type { WorkflowResponse } from "../../schemas/workflows";
import { killSandbox } from "../e2b/kill-sandbox";
import { hideEpisodesForWorkflow } from "../episodes/hide-for-workflow";
import { cancelWorkflowRun } from "./cancel-run";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import { deleteWorkflowVectorRows } from "./vector-refresh";
import type { WorkflowRequester } from "./visibility";

/** A run is done when it can no longer fire a turn or hold a Trigger.dev task. */
const NON_TERMINAL_RUN_STATUSES = ["queued", "running", "needs_approval"];

/**
 * PERMANENTLY delete an archived workflow and everything owned by its runs —
 * the destructive counterpart to `archiveWorkflow`. Guarded on `archived` so a
 * live/paused workflow can never be wiped by mistake (archive is the reversible
 * off-switch; delete is final). Tears down, in order:
 *   1. cancels any run still in flight (archiving doesn't stop in-flight runs —
 *      deleting the row under a live Trigger.dev task would orphan it);
 *   2. demotes the runs' memory episodes (idempotent — archive already did it);
 *   3. one tx: the workflow row (cascades `workflow_runs`) + the runs' own
 *      conversations (cascades `ai_chat_files`);
 *   4. the runs' S3 session folders + E2B sandboxes (no FK — would leak).
 * A run's `sourceConversationId` (the CHAT thread that launched a builder test)
 * is left untouched — only run-owned conversations are destroyed.
 */
export const deleteWorkflow = async (params: {
  id: string;
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse | undefined> => {
  const row = await getWorkflowRow({
    id: params.id,
    teamId: params.teamId,
    requester: params.requester,
  });
  if (!row) return undefined;
  if (row.status !== "archived") {
    return throwHttpError(
      400,
      badRequest("Archive the workflow before deleting it."),
    );
  }

  const runs = await db.query.workflowRuns.findMany({
    where: { workflowId: params.id },
    columns: { id: true, conversationId: true, status: true },
  });

  // Stop anything still running before the row vanishes. Best-effort: a Trigger
  // hiccup must not block the delete (the row is gone either way).
  for (const run of runs) {
    if (!NON_TERMINAL_RUN_STATUSES.includes(run.status)) continue;
    await cancelWorkflowRun({ runId: run.id, teamId: params.teamId }).catch(
      (error: unknown) => {
        console.warn(
          `[workflows.delete] cancel run ${run.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      },
    );
  }

  // Safety net — archive already demoted these; catches any straggler. Idempotent.
  await hideEpisodesForWorkflow({
    teamId: params.teamId,
    workflowId: params.id,
  }).catch((error: unknown) => {
    console.warn(
      `[workflows.delete] episode demote failed for ${params.id}:`,
      error instanceof Error ? error.message : error,
    );
  });

  const conversationIds = runs
    .map((r) => r.conversationId)
    .filter((v): v is string => v !== null);
  const serialized = serializeWorkflow(row);

  await db.transaction(async (tx) => {
    await tx
      .delete(workflows)
      .where(
        and(eq(workflows.id, params.id), eq(workflows.teamId, params.teamId)),
      );
    if (conversationIds.length > 0) {
      await tx
        .delete(aiConversations)
        .where(inArray(aiConversations.id, conversationIds));
    }
  });

  // The cascade reaped every `ai_chat_files` row; the S3 session folders + E2B
  // sandboxes have no FK and would leak without an explicit cleanup (mirrors
  // `deleteConversations`). Per-item failures are logged, never fatal.
  await Promise.all(
    conversationIds.flatMap((cid) => [
      deleteSessionFolder(cid),
      killSandbox(cid).catch((error: unknown) => {
        console.warn(
          `[workflows.delete] killSandbox failed for ${cid}:`,
          error instanceof Error ? error.message : error,
        );
      }),
    ]),
  );

  // `ai_vectors.source_id` is a plain string with no FK, so the cascade never
  // reaches the workflow's card — drop it explicitly or it stays searchable.
  await deleteWorkflowVectorRows(params.id);

  return serialized;
};
