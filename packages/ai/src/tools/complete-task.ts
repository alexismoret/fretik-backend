import { SYSTEM } from "@fretik/shared/authz/system-principals";
import { currentWorkflowTask } from "@fretik/shared/schemas/workflows";
import { completeCurrentTask } from "@fretik/shared/services/workflows/complete-current-task";
import { getWorkflowRunRow } from "@fretik/shared/services/workflows/get-run";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { fileExists } from "../lib/conversation-storage";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * File-ish tokens inside the `deliverable` sentence: a workspace-relative path
 * or a bare filename with an extension. Matched conservatively — a token has to
 * carry a dot and an extension of 1-8 word characters — because a false match
 * refuses a task that was legitimately done.
 */
const PATH_TOKEN =
  /(?:^|[\s"'`(,])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),.;:!?])/g;

const namedPaths = (deliverable: string): string[] => {
  const paths = new Set<string>();
  for (const match of deliverable.matchAll(PATH_TOKEN)) {
    const path = match[1];
    // A bare `1.5` or `v2.0` clears the regex but is not a file.
    if (path !== undefined && /[A-Za-z]/.test(path.split(".").pop() ?? "")) {
      paths.add(path);
    }
  }
  return [...paths];
};

/**
 * The completion check. Returns a tool error to send back instead of closing
 * the task, or `null` when the close may proceed.
 *
 * Refuses in exactly two cases, both recoverable by the agent on the spot:
 * a declared expected output closed `completed` with nothing said about where
 * it is, and a named file path that does not exist in the workspace. Anything
 * else — `skipped`, `failed`, a task with no declared output, a deliverable
 * that names values rather than files — passes through untouched.
 */
const checkDeliverable = async (params: {
  outcome: "completed" | "skipped" | "failed";
  deliverable: string | undefined;
  runId: string;
  conversationId: string | undefined;
}): Promise<ReturnType<typeof toolError> | null> => {
  if (params.outcome !== "completed") return null;
  // The run of THIS turn, named by the engine in the runtime context.
  const run = await getWorkflowRunRow({
    id: params.runId,
    principal: SYSTEM.workflowEngine,
  });
  if (!run) return null;
  const current = currentWorkflowTask(run.taskStates);
  const expected = current?.expectedOutput?.trim();
  if (expected === undefined || expected.length === 0) return null;

  const stated = params.deliverable?.trim() ?? "";
  if (stated.length === 0) {
    return toolError(
      TOOL_ERROR_CODES.INVALID_ARGS,
      `Task "${current?.key ?? ""}" declares an expected output and cannot be closed as completed without one.`,
      `Expected output: ${expected}\nRe-send completeTask with \`deliverable\` naming where that output is — the file paths you produced (e.g. "outputs/report.xlsx"), or the values themselves if it is not a file. If it does not exist yet, produce it first; if it cannot be produced, close the task with outcome "failed".`,
    );
  }

  const paths = namedPaths(stated);
  if (paths.length === 0 || params.conversationId === undefined) return null;

  const missing: string[] = [];
  for (const path of paths) {
    // A storage failure must not block a task that is genuinely done: an
    // unreachable sandbox reads as "cannot disprove", never as "missing".
    const exists = await fileExists(params.conversationId, path).catch(
      () => true,
    );
    if (!exists) missing.push(path);
  }
  if (missing.length === 0) return null;

  return toolError(
    TOOL_ERROR_CODES.INVALID_ARGS,
    `The deliverable names ${missing.length.toString()} file(s) that do not exist in the workspace: ${missing.join(", ")}.`,
    `Produce them, then re-send completeTask with the paths that exist. Check the real paths with \`bash\` (\`ls outputs/\`) before retrying — a task is not done because its summary says so. If the work cannot be done, close it with outcome "failed" and say why in \`summary\`.`,
  );
};

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
      deliverable: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "Required with `completed` when the task declares an expected output: WHERE that output is. Name the file paths you produced (`outputs/report.xlsx`), or state the values themselves when the output is not a file. Every path named here is checked against the workspace.",
        ),
      fatal: z
        .boolean()
        .optional()
        .describe(
          "With outcome `failed`: also abandon all remaining tasks and end the run.",
        ),
    }),
    execute: async ({ outcome, summary, deliverable, fatal }, options) => {
      const ctx = getRuntimeContext(options);
      if (ctx.workflowRunId === undefined) {
        return toolError(
          TOOL_ERROR_CODES.NO_WORKFLOW_RUN,
          "completeTask is only available inside a workflow run.",
        );
      }
      // ---- Completion check ----
      // A task that declares an expected output may not be closed `completed`
      // on an assertion alone. On 2026-09-17 a run closed `generer-fichiers`
      // ("Un jeu de 5 fichiers plats par facture") with a summary describing
      // the PREVIOUS task's work and zero files in existence, then spent 34
      // more minutes doing that work while the harness steered it toward the
      // task after it. Nothing in the loop could notice, because nothing asked.
      //
      // The check is deterministic, never a judgment on the prose: whatever
      // FILE PATHS the model names are looked up in the live workspace. Naming
      // no path is a valid answer — plenty of tasks deliver values, not files —
      // so a text deliverable can never be refused by this.
      const checked = await checkDeliverable({
        outcome,
        deliverable,
        runId: ctx.workflowRunId,
        conversationId: ctx.conversationId,
      });
      if (checked !== null) return checked;
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
        // The hint rides the `instruction` sentence, not just a bare array
        // field: a task reached mid-turn gets no steering message, so this
        // result is the only place its tool cue can land — and a JSON array
        // buried under a paragraph of instructions reads as metadata, not as
        // direction.
        const hints = next.toolHints ?? [];
        return {
          closedTask: { key: result.completed.key, status: outcome },
          nextTask: {
            key: next.key,
            title: next.title,
            instructions: next.instructions,
            ...(next.expectedOutput !== undefined
              ? { expectedOutput: next.expectedOutput }
              : {}),
            ...(hints.length > 0 ? { toolHints: hints } : {}),
          },
          instruction:
            hints.length > 0
              ? `Work on this task now, reaching for ${hints.join(", ")}.`
              : "Work on this task now.",
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
