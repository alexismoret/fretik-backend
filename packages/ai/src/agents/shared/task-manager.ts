/**
 * Per-conversation, in-memory task checklist (Phase 6).
 *
 * `TaskManager` holds the ephemeral list of 3+ step plans the model
 * maintains during a single turn so the user can see the plan and the
 * agent can stay on track. One instance lives for the duration of a
 * single request — the agent's `prepareCall` hook (see
 * `agent-builder.ts`) instantiates a fresh manager per turn and stores
 * it on `AgentRuntimeContext.taskManager`. No cross-request state, no
 * DB write.
 *
 * Shape and semantics are copied from Claude Code's `TodoWriteTool`
 * (see `claude-code/src/tools/TodoWriteTool/TodoWriteTool.ts` and
 * `claude-code/src/utils/todo/types.ts`):
 *
 *   - Full-replacement semantics: every call submits the whole list.
 *     No ids, no upsert, no order field — array order IS the order.
 *   - Each task carries both an imperative form (`content`, shown in
 *     the plan) and a present-continuous form (`activeForm`, shown
 *     while the task is `in_progress`).
 *
 * This is a deviation from the original Phase 6 plan which specified
 * upsert-by-id with a single `title` field. The full-replacement
 * pattern is simpler for the LLM (no id bookkeeping) and matches the
 * shape every other Fretik chatbot phase inherited from Claude Code.
 *
 * Distinct from Fretik's persistent workflows: workflows are
 * versioned, DB-backed, and executed by the BullMQ worker.
 * `TaskManager` is just a scratchpad for the current conversation.
 * See `chatbot-overhaul-plan.md` §Phase 6 for the full contrast.
 *
 * Storage V1 is in-memory only. If we ever need cross-session recall
 * of a task list, add an `ai_conversation_tasks` table in
 * `@fretik/shared/db/schema/ai.ts` and wire `getSnapshot()` to read
 * from it on construction — no external call sites change.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  content: string;
  activeForm: string;
  status: TaskStatus;
}

export class TaskManager {
  private tasks: Task[] = [];

  /**
   * Replace the current task list with `tasks`. Returns a fresh copy
   * of the new snapshot so callers never leak a reference into the
   * manager's internal array.
   *
   * **Concurrency contract.** Full-replacement semantics: two parallel
   * `setTasks` calls end in the state of whichever one executed last
   * — identical to a single call with that list, so no unobservable
   * intermediate state leaks. The agent never emits `manageTasks` in
   * parallel today (it's a planning step, deliberately serialized),
   * but the contract holds even if that changes. See
   * `runtime-context.ts::AgentRuntimeContext` mutation contract.
   */
  setTasks(tasks: readonly Task[]): Task[] {
    this.tasks = tasks.map((t) => ({ ...t }));
    return this.getSnapshot();
  }

  /**
   * Drop every task. The handler calls this in `onFinish` to prevent
   * any leaked state across turns — belt-and-suspenders since the
   * manager instance itself is already turn-scoped.
   */
  clear(): void {
    this.tasks = [];
  }

  /**
   * Immutable copy of the current task list. External readers never
   * have to worry about mutating the internal array.
   */
  getSnapshot(): Task[] {
    return this.tasks.map((t) => ({ ...t }));
  }
}
