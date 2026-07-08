import { completeCurrentTask } from "@fretik/shared/services/workflows/complete-current-task";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `completeTask` — the workflow executor's ONLY way to advance through its
 * playbook. The harness owns the cursor (the tool takes no task key, so the
 * model can never close the wrong task) and stamps `in_progress` itself; the
 * model only signals "the current task is done". The tool result carries the
 * NEXT task's instructions so the agent chains tasks within a single turn.
 * Because progression is impossible without calling it, the timeline can
 * never silently drift — a run that stops reporting visibly stalls and is
 * failed by the harness's no-progress guard.
 */
export const createCompleteTaskTool = () =>
  tool({
    description:
      "Close the CURRENT playbook task and receive the next one. Call it the moment a task's expected output exists — never batch several tasks before reporting. `completed` = done as specified; `skipped` = not applicable to this run's input; `failed` = could not be done (say why in `summary`). Set `fatal: true` only when continuing the remaining tasks would be pointless or harmful — it ends the run. When the result says all tasks are closed, write the final run summary as plain text and stop.",
    inputSchema: z.object({
      outcome: z.enum(["completed", "skipped", "failed"]),
      summary: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "One line, shown on the run timeline: what was produced, or why skipped/failed.",
        ),
      fatal: z
        .boolean()
        .optional()
        .describe(
          "With outcome `failed`: also abandon all remaining tasks and end the run.",
        ),
    }),
    execute: async ({ outcome, summary, fatal }, options) => {
      const ctx = getRuntimeContext(options);
      if (ctx.workflowRunId === undefined) {
        return toolError(
          TOOL_ERROR_CODES.NO_WORKFLOW_RUN,
          "completeTask is only available inside a workflow run.",
        );
      }
      const result = await completeCurrentTask({
        runId: ctx.workflowRunId,
        outcome,
        summary,
        ...(fatal !== undefined ? { fatal } : {}),
      });
      if (result.completed === null) {
        return {
          allTasksDone: true,
          instruction:
            "No task is open — all playbook tasks are already closed. Write the final run summary now, then stop.",
        };
      }
      if (result.next !== null) {
        const next = result.next;
        return {
          closedTask: { key: result.completed.key, status: outcome },
          nextTask: {
            key: next.key,
            title: next.title,
            instructions: next.instructions,
            ...(next.expectedOutput !== undefined
              ? { expectedOutput: next.expectedOutput }
              : {}),
            ...(next.toolHints !== undefined
              ? { toolHints: next.toolHints }
              : {}),
          },
          instruction: "Work on this task now.",
        };
      }
      return {
        closedTask: { key: result.completed.key, status: outcome },
        allTasksDone: true,
        instruction:
          "All playbook tasks are closed. Write the final run summary for the user now (plain text, no tool call), then stop.",
      };
    },
  });
