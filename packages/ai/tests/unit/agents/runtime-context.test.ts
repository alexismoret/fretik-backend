import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import {
  getRuntimeContext,
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "../../../src/agents/shared/runtime-context";
import { TaskManager } from "../../../src/agents/shared/task-manager";

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
  dynamicToolManager: new DynamicToolManager(),
  taskManager: new TaskManager(),
});

describe("runtime-context brand symbol round-trip", () => {
  test("wrap → get returns the same ctx fields", () => {
    const ctx = makeCtx();
    const wrapped = wrapRuntimeContext(ctx);
    const recovered = getRuntimeContext({ experimental_context: wrapped });

    expect(recovered.organizationId).toBe("org-1");
    expect(recovered.teamId).toBe("team-1");
    expect(recovered.userId).toBe("user-1");
    expect(recovered.userName).toBe("Alice");
    expect(recovered.conversationId).toBe("conv-1");
    expect(recovered.timeZone).toBe("Europe/Paris");
    expect(recovered.dynamicToolManager).toBe(ctx.dynamicToolManager);
    expect(recovered.taskManager).toBe(ctx.taskManager);
  });

  test("recovered ctx preserves manager identity so mutations propagate", () => {
    const ctx = makeCtx();
    const wrapped = wrapRuntimeContext(ctx);
    const recovered = getRuntimeContext({ experimental_context: wrapped });

    recovered.dynamicToolManager.activate(["listDocuments"]);
    expect(ctx.dynamicToolManager.getSnapshot()).toEqual(["listDocuments"]);

    recovered.taskManager.setTasks([
      { content: "do X", activeForm: "doing X", status: "pending" },
    ]);
    expect(ctx.taskManager.getSnapshot()).toHaveLength(1);
  });
});

describe("getRuntimeContext rejects unbranded values", () => {
  test("missing experimental_context throws", () => {
    expect(() => getRuntimeContext({})).toThrow(/Missing AgentRuntimeContext/);
  });

  test("null experimental_context throws", () => {
    expect(() => getRuntimeContext({ experimental_context: null })).toThrow(
      /Missing AgentRuntimeContext/,
    );
  });

  test("string experimental_context throws", () => {
    expect(() =>
      getRuntimeContext({ experimental_context: "not a context" }),
    ).toThrow(/Missing AgentRuntimeContext/);
  });

  test("plain object without brand throws", () => {
    expect(() =>
      getRuntimeContext({
        experimental_context: {
          organizationId: "org-1",
          teamId: "team-1",
          dynamicToolManager: new DynamicToolManager(),
          taskManager: new TaskManager(),
        },
      }),
    ).toThrow(/Missing AgentRuntimeContext/);
  });

  test("array experimental_context throws", () => {
    expect(() =>
      getRuntimeContext({ experimental_context: [1, 2, 3] }),
    ).toThrow(/Missing AgentRuntimeContext/);
  });
});
