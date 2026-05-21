import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";

/**
 * `manageTasks` — Fretik's equivalent of Claude Code's `TodoWriteTool`.
 *
 * Core tool (always loaded). Lets the model maintain a per-turn task
 * checklist for multi-step requests so the plan is visible to the
 * user and the agent stays on track. Every call REPLACES the whole
 * list — the model submits the current state of the world rather
 * than diffing it. This mirrors Claude Code exactly and avoids any
 * id bookkeeping on the model side.
 *
 * Each task carries two text forms:
 *   - `content`      — imperative, shown in the plan ("Run tests")
 *   - `activeForm`   — present-continuous, shown while the task is
 *                      `in_progress` ("Running tests")
 *
 * The description below is a Fretik-adapted condensate of Claude
 * Code's `TodoWriteTool/prompt.ts::PROMPT`, kept tight because the
 * system prompt carries the normative multi-step rules and examples.
 */

const TaskSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Imperative form describing what needs to be done (e.g. 'Compile the vendor report').",
    ),
  activeForm: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Present-continuous form shown while the task is in progress (e.g. 'Compiling the vendor report').",
    ),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe(
      "pending = not yet started, in_progress = currently working on (keep exactly one at a time), completed = finished successfully.",
    ),
});

export const createManageTasksTool = () =>
  tool({
    description: [
      "Create and update the per-turn task checklist for the current conversation. Use this proactively for any request that breaks into 3 or more distinct steps so the user can see your plan and you can track progress.",
      "",
      "Every call REPLACES the whole list. Submit the full set of tasks you want visible after this update — do not try to diff against the previous state. Each task must include both an imperative `content` and a present-continuous `activeForm`, plus a `status`.",
      "",
      "Rules:",
      "- Keep exactly one task as `in_progress` at any time, and mark it `in_progress` BEFORE you start working on it.",
      "- Mark a task `completed` immediately after finishing it — never batch completions to the end of the turn.",
      "- If a task becomes obsolete or merges with another, drop it from the next call instead of leaving stale entries.",
      "- Do NOT use this tool for trivial single-step questions, short Q&A, or purely informational requests.",
      "",
      "This list is ephemeral — it lives for the current conversation turn only and is cleared when the turn ends. It is a planning aid, not a persistent workflow.",
    ].join("\n"),
    inputSchema: z.object({
      tasks: z
        .array(TaskSchema)
        .max(30)
        .describe(
          "The full updated task list. Every call replaces the previous list entirely. Maximum 30 tasks per plan — if you need more, the task is too fine-grained; group related steps together.",
        ),
    }),
    execute: async ({ tasks }, options) => {
      const ctx = getRuntimeContext(options);
      const updated = ctx.taskManager.setTasks(tasks);
      return { tasks: updated };
    },
  });
