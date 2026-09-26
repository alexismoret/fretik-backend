import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * `checkAgents` — the mid-turn view on background sub-agents, and the one
 * other door (besides the resume) a report leaves through.
 *
 * The property that matters is that a report is handed over ONCE: whatever
 * this call collects it must consume, and only what it actually consumed may
 * it report — a resume racing it keeps the rows it claimed, and those reports
 * reach the agent through the resume instead. Doubled at the registry.
 */

let open: ConversationBackgroundTask[] = [];
let consumable = new Set<string>();
const consumedAsked: string[][] = [];

await mockModule("@fretik/shared/services/conversation-tasks/list", {
  listOpenSubAgentTasks: async () => open,
});
await mockModule("@fretik/shared/services/conversation-tasks/consume", {
  consumeConversationTasks: async (params: { refs: readonly string[] }) => {
    consumedAsked.push([...params.refs]);
    return open.filter((task) => consumable.has(task.ref));
  },
});

const { createCheckAgentsTool } =
  await import("../../../src/tools/check-agents");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");
const { getProfileForRole } =
  await import("../../../src/lib/model-registry/resolve");

const task = (
  ref: string,
  status: ConversationBackgroundTask["status"],
  subAgent: NonNullable<ConversationBackgroundTask["metadata"]>["subAgent"],
): ConversationBackgroundTask => ({
  id: `task-${ref}`,
  conversationId: "conv-1",
  kind: "sub_agent",
  ref,
  title: `Agent ${ref}`,
  status,
  metadata: { subAgent },
  completedAt: status === "pending" ? null : new Date(),
  consumedAt: null,
  createdAt: new Date(Date.now() - 4 * 60_000),
});

const check = async (): Promise<Record<string, unknown>> => {
  const tool = createCheckAgentsTool();
  if (tool.execute === undefined) throw new Error("no execute");
  const value: unknown = await tool.execute({}, {
    toolCallId: "call_c",
    messages: [],
    context: wrapRuntimeContext({
      organizationId: "org-1",
      teamId: "team-1",
      conversationId: "conv-1",
      modelProfile: getProfileForRole("chat"),
      dynamicToolManager: new DynamicToolManager(),
    }),
  } as never);
  return value as Record<string, unknown>;
};

beforeEach(() => {
  open = [];
  consumable = new Set();
  consumedAsked.length = 0;
});

describe("checkAgents", () => {
  test("it lists what still runs and hands over what finished", async () => {
    open = [
      task("a", "pending", {
        step: 7,
        activity: [
          {
            tool: "read",
            caption: "Reading the Q3 contract",
            state: "running",
          },
        ],
      }),
      task("b", "succeeded", {
        result: {
          status: "completed",
          summary: "Two clauses found.",
          files: ["outputs/clauses.md"],
          toolCalls: 9,
          durationMs: 120_000,
          activity: [],
        },
      }),
    ];
    consumable = new Set(["b"]);
    const out = await check();
    // Only the settled row is offered for consumption — never a running one.
    expect(consumedAsked).toEqual([["b"]]);
    expect(out.running).toEqual([
      {
        agentId: "a",
        description: "Agent a",
        step: 7,
        doing: "Reading the Q3 contract",
        runningForMinutes: 4,
      },
    ]);
    expect(out.finished).toEqual([
      {
        agentId: "b",
        description: "Agent b",
        status: "completed",
        summary: "Two clauses found.",
        files: ["outputs/clauses.md"],
        toolCalls: 9,
      },
    ]);
    expect(typeof out.next).toBe("string");
  });

  test("a report a resume claimed first is not handed over twice", async () => {
    open = [
      task("b", "succeeded", {
        result: {
          status: "completed",
          summary: "Done.",
          toolCalls: 1,
          durationMs: 1,
          activity: [],
        },
      }),
    ];
    // The consuming UPDATE lost the race: it returns nothing.
    consumable = new Set();
    const out = await check();
    expect(out.finished).toEqual([]);
  });

  test("a run that died without a report reads as failed", async () => {
    open = [task("c", "failed", { step: 3 })];
    consumable = new Set(["c"]);
    const out = await check();
    expect(out.finished).toEqual([
      {
        agentId: "c",
        description: "Agent c",
        status: "failed",
        summary: "It stopped before finishing and wrote no report.",
      },
    ]);
  });

  test("with nothing open it says so", async () => {
    const out = await check();
    expect(out).toEqual({
      running: [],
      finished: [],
      next: "No background sub-agent is open.",
    });
  });
});
