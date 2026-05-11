import type { UIMessage } from "ai";
import type { Task } from "../../agents/shared/task-manager";

/**
 * Runtime-state attachments — Fretik's equivalent of Claude Code's
 * `createPlanAttachmentIfNeeded` + `createSkillAttachmentIfNeeded`
 * (`compact.ts:1466+`).
 *
 * Audit of the Fretik codebase showed that almost every "file"
 * (persisted-output, uploaded attachments, drive downloads, sandbox
 * filesystem, context files) survives compaction without any
 * dedicated attachment, because:
 *   - The files themselves persist in E2B / Postgres / S3 (external
 *     to the message history), and
 *   - The system prompt rebuilders (`buildAttachedFilesBlock`,
 *     `buildChatbotContextManifest`) reconstruct the file index from
 *     scratch on every turn.
 *
 * The two pieces that DO live in the message history and would be
 * lost without explicit help are:
 *   1. `DynamicToolManager.activatedTools` — reconstructed from past
 *      `searchTools` tool-result payloads by
 *      `replayActivationFromHistory`. After full compaction, those
 *      payloads are gone.
 *   2. `TaskManager.tasks` — the in-flight checklist the model
 *      maintains via `manageTasks`. The TaskManager is per-request
 *      anyway, but the most-recent state is needed in the summary so
 *      the model knows where it left off.
 *
 * This module:
 *   - Extracts both states from a `UIMessage[]` history.
 *   - Formats them as a plain-text block to be appended to the
 *     compaction summary (`getCompactUserSummaryMessage`).
 *   - Synthesises a fake `tool-searchTools` UIMessage that preserves
 *     activatedTools through `convertToModelMessages` so the existing
 *     `replayActivationFromHistory` (in `agents/shared/dynamic-tools.ts`)
 *     finds the cumulative activation set after compaction WITHOUT
 *     any change to that function. The synthetic message is the
 *     only post-compact mechanism that actually drives runtime state;
 *     the text block in the summary is for the model's awareness only.
 *
 * @see agents/shared/dynamic-tools.ts
 * @see agents/shared/task-manager.ts
 * @see claude-code/src/services/compact/compact.ts createPlanAttachmentIfNeeded
 */

const TOOL_PART_PREFIX = "tool-";
const SEARCH_TOOLS_PART_TYPE = "tool-searchTools";
const MANAGE_TASKS_PART_TYPE = "tool-manageTasks";

export interface RuntimeStateSnapshot {
  /**
   * Cumulative set of domain tool names the model has activated via
   * past `searchTools` calls, in first-encounter order. May be empty
   * for short / pure-Q&A conversations.
   */
  activatedTools: string[];
  /**
   * Latest `manageTasks` snapshot at compaction time, filtered to
   * tasks that are not yet `completed` (the model only needs to know
   * what is still outstanding). Empty when the conversation never
   * called `manageTasks` or every task has been completed.
   */
  pendingTasks: Task[];
}

/**
 * Type guard for the structured payload returned by `searchTools.execute`
 * (`tools/search-tools.ts::execute`). Mirrors the shape inspected by
 * `replayActivationFromHistory` so we extract the same cumulative set.
 */
const extractMatchesFromSearchToolsOutput = (
  output: unknown,
): string[] | null => {
  if (output === null || output === undefined) return null;
  if (typeof output !== "object" || Array.isArray(output)) return null;
  const maybeMatches = (output as { matches?: unknown }).matches;
  if (!Array.isArray(maybeMatches)) return null;
  const names = maybeMatches.filter((n): n is string => typeof n === "string");
  return names;
};

/**
 * Type guard for the structured payload returned by `manageTasks.execute`
 * (`tools/manage-tasks.ts::execute`).
 */
const extractTasksFromManageTasksOutput = (output: unknown): Task[] | null => {
  if (output === null || output === undefined) return null;
  if (typeof output !== "object" || Array.isArray(output)) return null;
  const maybeTasks = (output as { tasks?: unknown }).tasks;
  if (!Array.isArray(maybeTasks)) return null;
  const tasks: Task[] = [];
  for (const t of maybeTasks) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) continue;
    const obj = t as Record<string, unknown>;
    const content = obj.content;
    const activeForm = obj.activeForm;
    const status = obj.status;
    if (
      typeof content !== "string" ||
      typeof activeForm !== "string" ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    ) {
      continue;
    }
    tasks.push({ content, activeForm, status });
  }
  return tasks;
};

/**
 * Walk the conversation messages and extract both the cumulative
 * activated-tool set and the latest pending-task list.
 *
 * Activated tools accumulate across every `searchTools` result
 * encountered (mirrors `replayActivationFromHistory`). Pending tasks
 * are the LATEST `manageTasks` snapshot, filtered to non-completed.
 */
export const extractRuntimeState = (
  messages: UIMessage[],
): RuntimeStateSnapshot => {
  const activated = new Set<string>();
  let latestTasks: Task[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
      if (
        part === undefined ||
        part === null ||
        typeof part !== "object" ||
        !("type" in part) ||
        typeof part.type !== "string"
      ) {
        continue;
      }
      if (!part.type.startsWith(TOOL_PART_PREFIX)) continue;
      if (!("state" in part) || part.state !== "output-available") continue;
      const output = "output" in part ? part.output : undefined;

      if (part.type === SEARCH_TOOLS_PART_TYPE) {
        const matches = extractMatchesFromSearchToolsOutput(output);
        if (matches) {
          for (const name of matches) activated.add(name);
        }
        continue;
      }

      if (part.type === MANAGE_TASKS_PART_TYPE) {
        const tasks = extractTasksFromManageTasksOutput(output);
        if (tasks) {
          // Latest call wins — keep overwriting as we walk forward.
          latestTasks = tasks;
        }
        continue;
      }
    }
  }

  const pendingTasks = latestTasks.filter((t) => t.status !== "completed");

  return {
    activatedTools: [...activated],
    pendingTasks,
  };
};

/**
 * Render a runtime-state snapshot as plain text to append after the
 * summary in `getCompactUserSummaryMessage`. Returns an empty string
 * when there is nothing useful to inject — the caller checks
 * `length > 0` before appending.
 */
export const formatRuntimeStateForSummary = (
  state: RuntimeStateSnapshot,
): string => {
  const lines: string[] = [];

  if (state.activatedTools.length > 0) {
    lines.push(
      `Active domain tools (already unlocked via searchTools — call them directly without re-running searchTools): ${state.activatedTools.join(", ")}`,
    );
  }

  if (state.pendingTasks.length > 0) {
    const taskLines = state.pendingTasks.map((t, i) => {
      const idx = (i + 1).toString();
      const statusLabel =
        t.status === "in_progress" ? "in_progress" : "pending";
      return `  ${idx}. ${t.content} (${statusLabel})`;
    });
    lines.push(`Pending tasks (from manageTasks at compaction time):`);
    lines.push(...taskLines);
  }

  return lines.join("\n");
};

/**
 * Build a synthetic assistant `UIMessage` that re-asserts the cumulative
 * activated-tool set, so `convertToModelMessages` produces a
 * `searchTools` tool-result message that
 * `replayActivationFromHistory` (in `agents/shared/dynamic-tools.ts`)
 * picks up unchanged.
 *
 * Returns `null` when there is nothing to assert (no tools were ever
 * activated). The caller skips the message in that case to avoid
 * polluting the post-compact history with a no-op.
 *
 * Why a UIMessage with a `tool-searchTools` part: at the chatbot
 * handler boundary we work in UIMessage space; the AI SDK's
 * `convertToModelMessages` then splits this into the standard
 * `assistant` (tool-call) + `tool` (tool-result) ModelMessage pair.
 * That pair is exactly what the existing replay function scans for —
 * no changes needed in dynamic-tools.ts.
 *
 * The synthesized `query` mirrors the `select:A,B,C` form used by
 * real `searchTools` calls so logs and any human inspecting the
 * persisted message history can tell what happened.
 */
export const buildSyntheticActivationReplayMessage = (
  activatedTools: string[],
): UIMessage | null => {
  if (activatedTools.length === 0) return null;

  const toolCallId = `compaction-replay-${crypto.randomUUID()}`;
  const query = `select:${activatedTools.join(",")}`;

  // Cast through `unknown` to satisfy the AI SDK's discriminated-union
  // generic on `UIMessage`. The shape below matches `ToolUIPart` with
  // `state: "output-available"` exactly — see node_modules/ai's
  // `UIToolInvocation`. We can't construct it via the typed factory
  // (no public constructor) so the safest path is a runtime-shaped
  // object validated by hand.
  const part = {
    type: SEARCH_TOOLS_PART_TYPE,
    toolCallId,
    state: "output-available" as const,
    input: { query },
    output: {
      matches: [...activatedTools],
      query,
      total_deferred_tools: activatedTools.length,
    },
  };

  const message: UIMessage = {
    id: `compaction-replay-${crypto.randomUUID()}`,
    role: "assistant",
    parts: [part] as UIMessage["parts"],
  };

  return message;
};
