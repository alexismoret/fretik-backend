import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import type { WorkflowRunOutput } from "@fretik/shared/schemas/workflows";
import { WORKSPACE_DIRS, writeFile } from "../../lib/conversation-storage";

/**
 * Make a workflow run's deliverables readable from a CHAT conversation, under
 * `runs/<runId>/`.
 *
 * A run executes in its own conversation (`createWorkflowRun` inserts a fresh
 * one) and every file tool is scoped to `ctx.conversationId` — so a chat could
 * not open what its own test run produced. Prod 2026-07-27: the builder tried
 * `read("outputs/…")`, searched the tool catalogue for a download tool, ran
 * `bash find outputs`, then graded four consecutive test runs on the summary
 * each run had written about itself.
 *
 * Modelled on `drive/`, NOT on `attachments/`: read-only, materialised on
 * demand, and deliberately outside `BACKUP_ELIGIBLE_DIRS`. The durable copy
 * stays in the run conversation's own S3 prefix, so this writes a sandbox-only
 * cache — no duplicated storage, no size ceiling, nothing to garbage-collect.
 * A sandbox that expired is re-populated by calling `get_run` again.
 *
 * Authorisation is the caller's: `get_run` has already resolved the run for
 * this team. Because nothing here depends on the run being a TEST or on it
 * having been launched from this very conversation, analysing a production run
 * from any chat is the same code path.
 *
 * Best-effort per file: a copy failure returns fewer paths, never throws.
 */
export const materializeRunOutputs = async (params: {
  runId: string;
  runConversationId: string;
  conversationId: string;
  outputs: WorkflowRunOutput[];
}): Promise<Map<string, string>> => {
  const byOriginalPath = new Map<string, string>();
  await Promise.all(
    params.outputs.map(async (output) => {
      if (output.filePath === undefined) return;
      const filename = output.filePath.slice(
        output.filePath.lastIndexOf("/") + 1,
      );
      if (filename.length === 0) return;
      const target = `${WORKSPACE_DIRS.runs}/${params.runId}/${filename}`;
      try {
        const bytes = await readSessionFile(
          params.runConversationId,
          output.filePath,
        );
        if (!bytes) return;
        await writeFile(params.conversationId, target, bytes, {
          contentType: output.mimeType,
        });
        byOriginalPath.set(output.filePath, target);
      } catch (err) {
        console.warn(
          `[run-outputs] ${params.runId} ${output.filePath} →`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  return byOriginalPath;
};
