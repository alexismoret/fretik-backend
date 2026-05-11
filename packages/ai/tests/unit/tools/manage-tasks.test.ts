import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import {
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "../../../src/agents/shared/runtime-context";
import {
  TaskManager,
  type Task,
} from "../../../src/agents/shared/task-manager";
import { createManageTasksTool } from "../../../src/tools/manage-tasks";

/**
 * Deterministic tool-contract tests for `manageTasks`. The eval
 * harness (`../evals/`) covers the behavioural question of WHEN the
 * agent decides to call the tool — these tests cover the much
 * narrower invariants the tool exposes to the AI SDK at call time:
 *
 *   - execute wires into `ctx.taskManager` with full-replace semantics
 *   - execute returns the manager's snapshot (deep copy), not the raw
 *     input array
 *   - execute throws when the runtime context is missing (the brand
 *     guard from `runtime-context.ts`)
 *
 * Schema-level validation is NOT tested here — `tool.inputSchema` is
 * typed as `FlexibleSchema<T>` (the AI SDK's union of Zod/JSONSchema/
 * custom validators) so we cannot directly call `.parse` without an
 * unsafe narrowing. The Zod schema itself lives in the production
 * module; TypeScript's structural type-check at the call site is the
 * first line of defence, and the AI SDK enforces the schema at the
 * live-call boundary before execute is ever reached. Type-narrowing
 * pattern below mirrors `chatbot-pd-integration.test.ts`.
 */

interface ManageTasksOutput {
  tasks: Task[];
}

const makeCtx = (): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  dynamicToolManager: new DynamicToolManager(),
  taskManager: new TaskManager(),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const narrowOutput = (result: unknown): ManageTasksOutput => {
  if (!isRecord(result)) {
    throw new Error(`manageTasks returned non-object: ${String(result)}`);
  }
  const tasks = result["tasks"];
  if (!Array.isArray(tasks)) {
    throw new Error("manageTasks 'tasks' is not an array");
  }
  const out: Task[] = [];
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    const content = t["content"];
    const activeForm = t["activeForm"];
    const status = t["status"];
    if (
      typeof content === "string" &&
      typeof activeForm === "string" &&
      (status === "pending" ||
        status === "in_progress" ||
        status === "completed")
    ) {
      out.push({ content, activeForm, status });
    }
  }
  return { tasks: out };
};

const callExecute = async (
  tool: ReturnType<typeof createManageTasksTool>,
  tasksInput: readonly Task[],
  ctx: AgentRuntimeContext,
): Promise<ManageTasksOutput> => {
  const execute = tool.execute;
  if (!execute) throw new Error("manageTasks has no execute fn");
  type ExecOptions = Parameters<NonNullable<typeof tool.execute>>[1];
  const options: ExecOptions = {
    toolCallId: "call-test",
    messages: [],
    experimental_context: wrapRuntimeContext(ctx),
  };
  const raw = await Promise.resolve(
    execute({ tasks: [...tasksInput] }, options),
  );
  return narrowOutput(raw);
};

describe("manageTasks — execute", () => {
  test("writes tasks into ctx.taskManager and returns the snapshot", async () => {
    const tool = createManageTasksTool();
    const ctx = makeCtx();
    const result = await callExecute(
      tool,
      [
        { content: "a", activeForm: "a-ing", status: "pending" },
        { content: "b", activeForm: "b-ing", status: "in_progress" },
      ],
      ctx,
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((t) => t.content)).toEqual(["a", "b"]);
    expect(result.tasks.map((t) => t.status)).toEqual([
      "pending",
      "in_progress",
    ]);
    expect(ctx.taskManager.getSnapshot()).toHaveLength(2);
  });

  test("full-replace semantics — second call overwrites first", async () => {
    const tool = createManageTasksTool();
    const ctx = makeCtx();
    await callExecute(
      tool,
      [
        { content: "a", activeForm: "a-ing", status: "pending" },
        { content: "b", activeForm: "b-ing", status: "pending" },
      ],
      ctx,
    );
    const result = await callExecute(
      tool,
      [{ content: "c", activeForm: "c-ing", status: "completed" }],
      ctx,
    );
    expect(result.tasks).toHaveLength(1);
    const [first] = result.tasks;
    if (!first) throw new Error("expected one task");
    expect(first.content).toBe("c");
    expect(ctx.taskManager.getSnapshot()).toHaveLength(1);
  });

  test("returned snapshot is a deep copy — mutating it does not affect state", async () => {
    const tool = createManageTasksTool();
    const ctx = makeCtx();
    const result = await callExecute(
      tool,
      [{ content: "a", activeForm: "a-ing", status: "pending" }],
      ctx,
    );
    const [firstTask] = result.tasks;
    if (!firstTask) throw new Error("expected one task");
    firstTask.status = "completed";
    const [snapshotTask] = ctx.taskManager.getSnapshot();
    expect(snapshotTask?.status).toBe("pending");
  });

  test("throws when runtime context is missing", async () => {
    const tool = createManageTasksTool();
    const execute = tool.execute;
    if (!execute) throw new Error("manageTasks has no execute fn");
    type ExecOptions = Parameters<NonNullable<typeof tool.execute>>[1];
    const options: ExecOptions = {
      toolCallId: "call-test",
      messages: [],
      // Intentionally no experimental_context — getRuntimeContext must throw.
    };
    let threw = false;
    try {
      await Promise.resolve(execute({ tasks: [] }, options));
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/AgentRuntimeContext/);
    }
    expect(threw).toBe(true);
  });
});
