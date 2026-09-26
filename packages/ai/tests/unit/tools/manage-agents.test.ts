import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { mockModule } from "../../lib/mock-module";

/**
 * `manageAgents` — the parent's hold on the sub-agents it started.
 *
 * What this pins, each one a way the feature fails silently:
 *  - a report is handed over ONCE: collected here, it is consumed, so the
 *    conversation is not woken later to deliver it again;
 *  - a report asked for by id comes back even if it was read before — a
 *    compaction may have dropped it from the parent's context;
 *  - `wait` returns as soon as its targets have finished, and a Stop of the
 *    turn cuts it short instead of holding the answer open;
 *  - `stop` goes out as the ASSISTANT's stop (quiet: it settles consumed and
 *    wakes nobody) and hands back what the runs had done.
 *
 * Doubled at the process boundary: the task registry (Postgres).
 */

interface Row {
  ref: string;
  title: string;
  status: string;
  consumedAt: Date | null;
  createdAt: Date;
  metadata: { subAgent?: Record<string, unknown> } | null;
}

let rows: Row[] = [];
/** Rows as the NEXT read will see them — a run settling between two reads. */
let afterReads: { reads: number; apply: () => void } | undefined;
let reads = 0;
const consumedRefs: string[] = [];
const stopRequests: Record<string, unknown>[] = [];

const read = (): void => {
  reads += 1;
  if (afterReads !== undefined && reads >= afterReads.reads) {
    afterReads.apply();
    afterReads = undefined;
  }
};

await mockModule("@fretik/shared/services/conversation-tasks/list", {
  listOpenSubAgentTasks: async () => {
    read();
    return rows.filter(
      (row) => row.status === "pending" || row.consumedAt === null,
    );
  },
  listSubAgentTasks: async (_conversationId: string, ids: string[]) => {
    read();
    return rows.filter((row) => ids.includes(row.ref));
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/consume", {
  consumeConversationTasks: async (params: { refs?: string[] }) => {
    const claimed = rows.filter(
      (row) =>
        (params.refs ?? []).includes(row.ref) &&
        row.status !== "pending" &&
        row.consumedAt === null,
    );
    for (const row of claimed) {
      row.consumedAt = new Date();
      consumedRefs.push(row.ref);
    }
    return claimed;
  },
});
await mockModule(
  "@fretik/shared/services/conversation-tasks/request-sub-agent-stop",
  {
    requestSubAgentStop: async (params: {
      agentIds?: string[];
      all?: true;
    }) => {
      stopRequests.push(params);
      const asked = rows.filter(
        (row) =>
          row.status === "pending" &&
          (params.all === true || (params.agentIds ?? []).includes(row.ref)),
      );
      for (const row of asked) {
        // The worker hears it and settles quietly: canceled AND consumed.
        row.status = "canceled";
        row.consumedAt = new Date();
        row.metadata = {
          subAgent: {
            ...row.metadata?.subAgent,
            stopRequested: "parent",
            result: {
              status: "failed",
              reason: "stopped",
              summary: "The sub-agent was stopped after 3 tool calls.",
              files: ["outputs/draft.md"],
              toolCalls: 3,
              durationMs: 60_000,
              activity: [],
            },
          },
        };
      }
      return asked.map((row) => row.ref);
    },
  },
);

const { createManageAgentsTool } =
  await import("../../../src/tools/manage-agents");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");
const { getProfileForRole } =
  await import("../../../src/lib/model-registry/resolve");

const tool = createManageAgentsTool();

const ctx = (
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  conversationId: "conv-1",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  ...overrides,
});

const call = async (
  input: Record<string, unknown>,
  options: { ctx?: AgentRuntimeContext; abortSignal?: AbortSignal } = {},
): Promise<Record<string, unknown>> => {
  const execute = tool.execute;
  if (execute === undefined) throw new Error("manageAgents has no execute");
  const output: unknown = await execute(
    input as never,
    {
      toolCallId: "call_m",
      messages: [],
      context: wrapRuntimeContext(options.ctx ?? ctx()),
      ...(options.abortSignal !== undefined
        ? { abortSignal: options.abortSignal }
        : {}),
    } as never,
  );
  return output as Record<string, unknown>;
};

const running = (ref: string, state: Record<string, unknown> = {}): Row => ({
  ref,
  title: `Agent ${ref}`,
  status: "pending",
  consumedAt: null,
  createdAt: new Date(),
  metadata: { subAgent: state },
});

const finished = (ref: string, consumedAt: Date | null = null): Row => ({
  ref,
  title: `Agent ${ref}`,
  status: "succeeded",
  consumedAt,
  createdAt: new Date(),
  metadata: {
    subAgent: {
      result: {
        status: "completed",
        summary: `Report of ${ref}.`,
        toolCalls: 7,
        durationMs: 120_000,
        activity: [],
      },
    },
  },
});

const refsOf = (list: unknown): string[] =>
  (list as { agentId: string }[]).map((agent) => agent.agentId);

beforeEach(() => {
  rows = [];
  afterReads = undefined;
  reads = 0;
  consumedRefs.length = 0;
  stopRequests.length = 0;
});

describe("manageAgents — status", () => {
  test("says who still runs, and hands over the reports nobody read", async () => {
    rows = [
      running("a", {
        step: 4,
        startedAt: Date.now(),
        activity: [{ tool: "searchWeb", caption: "Searching", state: "done" }],
      }),
      running("q"),
      finished("b"),
      finished("old", new Date()),
    ];
    const output = await call({ action: "status" });
    expect(output.running).toEqual([
      {
        agentId: "a",
        description: "Agent a",
        step: 4,
        doing: "Searching",
        runningForMinutes: 0,
      },
      // Waiting for a worker: it has not started.
      {
        agentId: "q",
        description: "Agent q",
        step: 0,
        queued: true,
        runningForMinutes: 0,
      },
    ]);
    // A report read before is not handed over again unless asked for.
    expect(refsOf(output.finished)).toEqual(["b"]);
    expect(consumedRefs).toEqual(["b"]);
    expect(String(output.next)).toContain("end your turn");
  });

  test("a report asked for by id comes back, even one read before", async () => {
    rows = [finished("old", new Date())];
    const output = await call({ action: "status", agentIds: ["old"] });
    expect(output.finished).toEqual([
      {
        agentId: "old",
        description: "Agent old",
        status: "completed",
        summary: "Report of old.",
        toolCalls: 7,
      },
    ]);
    expect(consumedRefs).toEqual([]);
  });

  test("nothing open says so", async () => {
    const output = await call({ action: "status" });
    expect(output.running).toEqual([]);
    expect(output.finished).toEqual([]);
    expect(String(output.next)).toContain("No sub-agent is running");
  });

  test("no conversation, no sub-agents", async () => {
    const output = await call(
      { action: "status" },
      { ctx: ctx({ conversationId: undefined }) },
    );
    expect(output.code).toBe("NO_CONVERSATION");
  });
});

describe("manageAgents — wait", () => {
  test("returns once they have finished, with their reports", async () => {
    rows = [running("a")];
    // The run settles between the first read and the next poll.
    afterReads = {
      reads: 2,
      apply: () => {
        rows = [finished("a")];
      },
    };
    const output = await call({ action: "wait" });
    expect(output.running).toEqual([]);
    expect(refsOf(output.finished)).toEqual(["a"]);
    expect(consumedRefs).toEqual(["a"]);
    expect(output.next).toBeUndefined();
  });

  test("the turn's Stop cuts a wait short, and says what still runs", async () => {
    rows = [running("a")];
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    const startedAt = Date.now();
    const output = await call(
      { action: "wait" },
      { abortSignal: controller.signal },
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(refsOf(output.running)).toEqual(["a"]);
    expect(String(output.next)).toContain("End your turn");
  });

  test("in a workflow run, a wait that ends early says to wait again", async () => {
    rows = [running("a")];
    const controller = new AbortController();
    controller.abort();
    const output = await call(
      { action: "wait" },
      {
        ctx: ctx({ workflowRunId: "run-1" }),
        abortSignal: controller.signal,
      },
    );
    expect(String(output.next)).toContain("Wait again");
  });
});

describe("manageAgents — stop", () => {
  test("stops them as the assistant, and hands back what they had done", async () => {
    rows = [running("a"), running("b"), finished("c")];
    const output = await call({ action: "stop", agentIds: ["a", "c"] });
    expect(stopRequests).toEqual([
      { conversationId: "conv-1", by: "parent", agentIds: ["a", "c"] },
    ]);
    expect(output.running).toEqual([]);
    expect(output.finished).toEqual([
      {
        agentId: "a",
        description: "Agent a",
        status: "failed",
        summary: "The sub-agent was stopped after 3 tool calls.",
        files: ["outputs/draft.md"],
        reason: "stopped",
        toolCalls: 3,
        stoppedBy: "parent",
      },
    ]);
    // `b` was not named and keeps going.
    expect(rows.find((row) => row.ref === "b")?.status).toBe("pending");
  });

  test("unnamed, every running one stops", async () => {
    rows = [running("a"), running("b")];
    const output = await call({ action: "stop" });
    expect(stopRequests[0]).toEqual({
      conversationId: "conv-1",
      by: "parent",
      all: true,
    });
    expect(refsOf(output.finished).sort()).toEqual(["a", "b"]);
  });

  test("stopping what already finished says there was nothing to stop", async () => {
    rows = [finished("c")];
    const output = await call({ action: "stop", agentIds: ["c"] });
    expect(String(output.next)).toContain("nothing to stop");
  });
});
