import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import {
  getRuntimeContext,
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "../../../src/agents/shared/runtime-context";
import { TaskManager } from "../../../src/agents/shared/task-manager";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * Fixture — a minimal ctx with every field populated. The real one
 * comes from `prepareCall` in `agent-builder.ts`; tests construct
 * it by hand to avoid pulling in openrouter/redis/S3 dependencies.
 */
const makeCtx = (): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  userId: "user-1",
  userName: "Alice",
  conversationId: "conv-1",
  timeZone: "Europe/Paris",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  taskManager: new TaskManager(),
});

describe("runtime-context brand symbol round-trip", () => {
  // v7: tools read the ctx via `options.context` (fed by `toolsContext`);
  // `prepareStep` reads it via `options.runtimeContext`. The facade accepts
  // either channel.
  test("wrap → get via `context` (tool channel) returns the same ctx fields", () => {
    const ctx = makeCtx();
    const wrapped = wrapRuntimeContext(ctx);
    const recovered = getRuntimeContext({ context: wrapped });

    expect(recovered.organizationId).toBe("org-1");
    expect(recovered.teamId).toBe("team-1");
    expect(recovered.userId).toBe("user-1");
    expect(recovered.userName).toBe("Alice");
    expect(recovered.conversationId).toBe("conv-1");
    expect(recovered.timeZone).toBe("Europe/Paris");
    expect(recovered.dynamicToolManager).toBe(ctx.dynamicToolManager);
    expect(recovered.taskManager).toBe(ctx.taskManager);
  });

  test("wrap → get via `runtimeContext` (prepareStep channel) works too", () => {
    const ctx = makeCtx();
    const wrapped = wrapRuntimeContext(ctx);
    const recovered = getRuntimeContext({ runtimeContext: wrapped });
    expect(recovered.dynamicToolManager).toBe(ctx.dynamicToolManager);
  });

  test("mutation contract: same reference across both channels", () => {
    // The SAME branded object is fanned out to every tool's `context` AND is
    // the agent's `runtimeContext`. A tool mutating its `context` must be
    // visible when `prepareStep` reads `runtimeContext` on the next step.
    const ctx = makeCtx();
    const wrapped = wrapRuntimeContext(ctx);
    const fromTool = getRuntimeContext({ context: wrapped });
    const fromPrepareStep = getRuntimeContext({ runtimeContext: wrapped });

    fromTool.dynamicToolManager.activate(["listDocuments"]);
    expect(fromPrepareStep.dynamicToolManager.getSnapshot()).toEqual([
      "listDocuments",
    ]);

    fromTool.taskManager.setTasks([
      { content: "do X", activeForm: "doing X", status: "pending" },
    ]);
    expect(fromPrepareStep.taskManager.getSnapshot()).toHaveLength(1);
  });
});

describe("getRuntimeContext rejects unbranded values", () => {
  test("missing context throws", () => {
    expect(() => getRuntimeContext({})).toThrow(/Missing AgentRuntimeContext/);
  });

  test("null context throws", () => {
    expect(() => getRuntimeContext({ context: null })).toThrow(
      /Missing AgentRuntimeContext/,
    );
  });

  test("string context throws", () => {
    expect(() => getRuntimeContext({ context: "not a context" })).toThrow(
      /Missing AgentRuntimeContext/,
    );
  });

  test("plain object without brand throws", () => {
    expect(() =>
      getRuntimeContext({
        context: {
          organizationId: "org-1",
          teamId: "team-1",
          modelProfile: getProfileForRole("chat"),
          dynamicToolManager: new DynamicToolManager(),
          taskManager: new TaskManager(),
        },
      }),
    ).toThrow(/Missing AgentRuntimeContext/);
  });

  test("array context throws", () => {
    expect(() => getRuntimeContext({ context: [1, 2, 3] })).toThrow(
      /Missing AgentRuntimeContext/,
    );
  });
});
