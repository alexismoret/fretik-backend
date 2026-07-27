import type { Workflow, WorkflowRun } from "@fretik/shared/db/schema";
import {
  currentWorkflowTask,
  type WorkflowTaskState,
} from "@fretik/shared/schemas/workflows";

/**
 * Render the `{{playbookBlock}}` fragment + the per-turn steering message —
 * the workflow prompt's task-recitation machinery, split for prompt caching.
 *
 * The block (system prompt) carries ONLY what is stable for the whole run:
 * goal, autonomy, the full task list with instructions + expected outputs. It
 * has NO live status, so the workflow system prompt is byte-identical every
 * turn — consecutive turns reuse the provider's cached prefix.
 *
 * Everything that mutates per turn — the current date, the live task-status
 * table, per-task outcomes, the current-task pin, and turn-1 memory recall —
 * rides in the steering message (user role, appended at the very tail).
 */

const TRIGGER_PAYLOAD_MAX_CHARS = 4000;

const statusMarker: Record<WorkflowTaskState["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  skipped: "[~]",
  failed: "[!]",
};

const formatTriggerPayload = (payload: Record<string, unknown>): string => {
  if (Object.keys(payload).length === 0) return "";
  const json = JSON.stringify(payload, null, 2);
  return json.length > TRIGGER_PAYLOAD_MAX_CHARS
    ? `${json.slice(0, TRIGGER_PAYLOAD_MAX_CHARS)}\n… (truncated)`
    : json;
};

/**
 * The static `{{playbookBlock}}` — goal, autonomy, trigger payload, and the
 * full ordered task list with instructions. NO status markers or outcomes
 * (those live in the steering message), so this fragment is byte-stable for
 * the whole run and the system prompt caches across turns.
 */
export const buildPlaybookBlock = (
  workflow: Workflow,
  run: WorkflowRun,
): string => {
  const lines: string[] = [
    `**Workflow:** ${workflow.name}`,
    `**Goal:** ${workflow.playbook.goal}`,
    `**Autonomy mode:** \`${workflow.autonomy}\` (see <writes_and_approvals>)`,
  ];
  if (workflow.playbook.successCriteria) {
    lines.push(`**Success criteria:** ${workflow.playbook.successCriteria}`);
  }
  if (workflow.playbook.deliverable) {
    // The output contract — this run never saw the chat where the workflow was
    // built, so the deliverable's exact shape lives here. Match it exactly.
    lines.push(
      `**Deliverable (${workflow.playbook.deliverable.format}) — produce EXACTLY this:** ${workflow.playbook.deliverable.description}`,
    );
  }
  if (workflow.playbook.notes) {
    lines.push(`**Notes:** ${workflow.playbook.notes}`);
  }
  const payload = formatTriggerPayload(run.triggerPayload);
  if (payload.length > 0) {
    lines.push("", "**Trigger payload:**", "```json", payload, "```");
  }
  lines.push(
    "",
    "**Tasks** (in order — the steering message tracks the live cursor and statuses):",
  );
  for (const task of run.taskStates) {
    lines.push(
      `- \`${task.key}\` — **${task.title}**${task.description.length > 0 ? ` — ${task.description}` : ""}`,
    );
    lines.push(`    Instructions: ${task.instructions}`);
    if (task.expectedOutput !== undefined) {
      lines.push(`    Expected output: ${task.expectedOutput}`);
    }
  }
  return lines.join("\n");
};

/** One-line live status table: `[x] \`k1\` · [>] \`k3\` · [ ] \`k4\``. */
const buildStatusTable = (tasks: WorkflowTaskState[]): string =>
  tasks.map((t) => `${statusMarker[t.status]} \`${t.key}\``).join(" · ");

/**
 * The per-turn steering user message — carries everything that mutates
 * between turns so the system prompt stays byte-stable. First turn announces
 * the trigger; later turns re-pin. The current task is pinned by key + title
 * + expected output ONLY — the full instructions live once in the system
 * playbook, so nothing is duplicated. `nudge` fires when the previous turn
 * ended without any task transition; `wrapUp` when the run nears its deadline;
 * `activeMemoryBlock` carries turn-1 recall (it persists via history after).
 */
export const buildSteeringMessage = (params: {
  run: WorkflowRun;
  turnIndex: number;
  currentDate: string;
  activeMemoryBlock?: string;
  nudge: boolean;
  wrapUp: boolean;
}): string => {
  const current = currentWorkflowTask(params.run.taskStates);
  const lines: string[] = [];
  if (params.turnIndex === 1) {
    lines.push(
      `The workflow was triggered (${params.run.triggerType}${params.run.isTest ? ", TEST run" : ""}). Execute the playbook.`,
    );
  } else {
    lines.push("Continue the run.");
  }
  lines.push("", `Current date: ${params.currentDate}`);
  if (current) {
    lines.push("", `Current task: \`${current.key}\` — **${current.title}**`);
    if (current.expectedOutput !== undefined) {
      lines.push(`Expected output: ${current.expectedOutput}`);
    }
    if (current.toolHints !== undefined && current.toolHints.length > 0) {
      lines.push(`Suggested tools: ${current.toolHints.join(", ")}`);
    }
  } else {
    lines.push(
      "",
      "All playbook tasks are closed. Write the final run summary now, then stop.",
    );
  }
  lines.push("", `Task status: ${buildStatusTable(params.run.taskStates)}`);
  const outcomes = params.run.taskStates.filter((t) => t.summary !== undefined);
  if (outcomes.length > 0) {
    lines.push("Outcomes:");
    for (const t of outcomes) lines.push(`- \`${t.key}\`: ${t.summary ?? ""}`);
  }
  if (params.nudge && current) {
    lines.push(
      "",
      `Reminder: task \`${current.key}\` is still open and the previous turn reported no progress. If its expected output already exists, call \`completeTask\` NOW; otherwise do the next concrete piece of work on it.`,
    );
  }
  if (params.wrapUp) {
    lines.push(
      "",
      "TIME LIMIT APPROACHING: this run is close to its wall-clock budget. Wrap up now — close the current task with what you have (use `skipped`/`failed` honestly where needed), then write the final summary.",
    );
  }
  if (
    params.activeMemoryBlock !== undefined &&
    params.activeMemoryBlock.length > 0
  ) {
    lines.push(
      "",
      "<active_memory>",
      params.activeMemoryBlock,
      "</active_memory>",
    );
  }
  return lines.join("\n");
};
