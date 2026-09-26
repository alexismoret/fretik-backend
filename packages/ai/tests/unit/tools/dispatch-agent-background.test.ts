import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { mockModule } from "../../lib/mock-module";

/**
 * `dispatchAgent({ background: true })` — the tool answers at once and the
 * run goes on without the turn that launched it.
 *
 * What this pins, each one a way the feature fails silently:
 *  - the wait is REGISTERED before the tool answers — otherwise a turn ending
 *    right after sees nothing pending and nobody is ever resumed;
 *  - the outcome lands on the task WITH the report, then wakes the
 *    conversation — the report has nowhere else to live;
 *  - the launching turn's Stop does not reach the run;
 *  - the run keeps its own ledger key and kernel;
 *  - a workflow run ignores the flag (nobody to resume there);
 *  - the per-turn budget still refuses, and a run that throws still settles.
 *
 * Doubled at the process boundaries: the task registry (Postgres), the
 * heartbeat and the resume signal (Redis). The sub-agent is a stub.
 */

interface Registered {
  conversationId: string;
  kind: string;
  ref: string;
  title: string;
  metadata?: { subAgent?: Record<string, unknown> };
}
interface Completed {
  kind: string;
  ref: string;
  status: string;
  metadata?: { subAgent?: { result?: Record<string, unknown> } };
}

const registered: Registered[] = [];
const completed: Completed[] = [];
const resumed: string[] = [];
const heartbeats: { beat: string[]; cleared: string[] } = {
  beat: [],
  cleared: [],
};

await mockModule("@fretik/shared/services/conversation-tasks/register", {
  registerConversationTask: async (params: Registered) => {
    registered.push(params);
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/complete", {
  completeConversationTask: async (params: Completed) => {
    completed.push(params);
    return { conversationId: "conv-1", transitioned: true };
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/patch-metadata", {
  patchConversationTaskMetadata: async () => undefined,
});
await mockModule("@fretik/shared/lib/sub-agent-heartbeat", {
  beatSubAgent: async (agentId: string) => {
    heartbeats.beat.push(agentId);
  },
  clearSubAgentHeartbeat: async (agentId: string) => {
    heartbeats.cleared.push(agentId);
  },
});
await mockModule("@fretik/shared/lib/conversation-task-resume", {
  publishConversationTaskResume: async (conversationId: string) => {
    resumed.push(conversationId);
  },
});
await mockModule("@fretik/shared/services/e2b/release-python-context", {
  releasePythonContext: async () => undefined,
});

const { createDispatchAgentTool } =
  await import("../../../src/tools/dispatch-agent");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");
const { resetDelegationSlots } =
  await import("../../../src/agents/shared/delegation-slots");
const { getProfileForRole } =
  await import("../../../src/lib/model-registry/resolve");

interface Generated {
  options: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

/**
 * A sub-agent that finishes only when told to — so a test can see what the
 * tool answered BEFORE the run ended.
 */
const gatedAgent = (generated: Generated[], mode: "ok" | "throw" = "ok") => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const agent = {
    version: "agent-v1" as const,
    id: "stub",
    tools: {},
    stream: () => {
      throw new Error("not used");
    },
    generate: async (params: {
      options: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      generated.push({
        options: params.options,
        abortSignal: params.abortSignal,
      });
      await gate;
      if (mode === "throw") throw new Error("upstream exploded");
      return {
        text: "Three payment-term practices found.",
        finishReason: "stop",
        steps: [],
        responseMessages: [],
      };
    },
  };
  return { agent, release: () => open() };
};

const build = (agent: unknown) =>
  createDispatchAgentTool({
    resolve: () => ({
      primary: agent as never,
      fallback: agent as never,
      contextCeiling: 100_000,
    }),
  });

const parentCtx = (
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  userId: "user-1",
  conversationId: "conv-1",
  traceId: "turn-1",
  timeZone: "Europe/Paris",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  ...overrides,
});

const call = async (
  tool: ReturnType<typeof build>,
  input: Record<string, unknown>,
  ctx: AgentRuntimeContext,
  abortSignal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const execute = tool.execute;
  if (execute === undefined) throw new Error("dispatchAgent has no execute");
  const value: unknown = await Promise.resolve(
    execute(
      {
        task: "Research B2B payment-term practices published this year",
        description: "Payment terms watch",
        ...input,
      },
      {
        toolCallId: "call_1",
        messages: [],
        context: wrapRuntimeContext(ctx),
        ...(abortSignal !== undefined ? { abortSignal } : {}),
      } as never,
    ),
  );
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  ) {
    let last: unknown;
    for await (const item of value as AsyncIterable<unknown>) last = item;
    return last as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
};

/** Let the detached run reach its end. */
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
};

beforeEach(() => {
  resetDelegationSlots();
  registered.length = 0;
  completed.length = 0;
  resumed.length = 0;
  heartbeats.beat.length = 0;
  heartbeats.cleared.length = 0;
});

afterEach(() => {
  delete process.env.DISPATCH_AGENT_MAX_PER_TURN;
});

describe("dispatchAgent in the background", () => {
  test("it answers at once, with its wait already registered", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated);
    const ctx = parentCtx();
    const answer = await call(build(agent), { background: true }, ctx);

    expect(answer.status).toBe("background");
    const agentId = String(answer.agentId);
    expect(registered).toEqual([
      {
        conversationId: "conv-1",
        kind: "sub_agent",
        ref: agentId,
        title: "Payment terms watch",
        metadata: {
          subAgent: { launchedByUserId: "user-1", toolCallId: "call_1" },
        },
      },
    ]);
    // Still running: nothing settled, nobody woken.
    expect(completed).toEqual([]);
    expect(resumed).toEqual([]);
    // `checkAgents` joins the parent's tools from its next step.
    expect(ctx.dynamicToolManager.isActivated("checkAgents")).toBe(true);
    release();
    await until(() => resumed.length === 1);
  });

  test("its report lands on the task, then the conversation is woken", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated);
    const answer = await call(build(agent), { background: true }, parentCtx());
    release();
    await until(() => resumed.length === 1);

    expect(completed).toHaveLength(1);
    const done = completed[0];
    expect(done?.ref).toBe(String(answer.agentId));
    expect(done?.status).toBe("succeeded");
    expect(done?.metadata?.subAgent?.result?.status).toBe("completed");
    expect(done?.metadata?.subAgent?.result?.summary).toBe(
      "Three payment-term practices found.",
    );
    expect(resumed).toEqual(["conv-1"]);
    expect(heartbeats.beat).toContain(String(answer.agentId));
    expect(heartbeats.cleared).toEqual([String(answer.agentId)]);
  });

  test("the launching turn's Stop does not reach it", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated);
    const stopped = new AbortController();
    stopped.abort();
    await call(build(agent), { background: true }, parentCtx(), stopped.signal);
    await until(() => generated.length === 1);
    expect(generated[0]?.abortSignal?.aborted).toBe(false);
    release();
    await until(() => resumed.length === 1);
    expect(completed[0]?.status).toBe("succeeded");
  });

  test("it runs under its own ledger key and its own kernel", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated);
    const answer = await call(build(agent), { background: true }, parentCtx());
    await until(() => generated.length === 1);
    const agentId = String(answer.agentId);
    // No dot: the launching turn's ledger entry is gone by the time it ends.
    expect(generated[0]?.options.traceId).toBe(`subagent-${agentId}`);
    expect(generated[0]?.options.delegateRunId).toBe(agentId);
    release();
    await until(() => resumed.length === 1);
  });

  test("in a workflow run the flag is ignored and it runs in the foreground", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated);
    const pending = call(
      build(agent),
      { background: true },
      parentCtx({ workflowRunId: "run-1" }),
    );
    await until(() => generated.length === 1);
    release();
    const answer = await pending;
    expect(answer.status).toBe("completed");
    expect(registered).toEqual([]);
  });

  test("the turn's budget still refuses it, before anything is registered", async () => {
    process.env.DISPATCH_AGENT_MAX_PER_TURN = "1";
    const generated: Generated[] = [];
    const first = gatedAgent(generated);
    const tool = build(first.agent);
    const ctx = parentCtx();
    await call(tool, { background: true }, ctx);
    const refused = await call(tool, { background: true }, ctx);
    expect(refused.code).toBe("DELEGATION_LIMIT");
    expect(registered).toHaveLength(1);
    first.release();
    await until(() => resumed.length === 1);
  });

  test("a run that throws still settles, as failed, and still wakes", async () => {
    const generated: Generated[] = [];
    const { agent, release } = gatedAgent(generated, "throw");
    await call(build(agent), { background: true }, parentCtx());
    release();
    await until(() => resumed.length === 1);
    expect(completed[0]?.status).toBe("failed");
    expect(completed[0]?.metadata?.subAgent?.result?.status).toBe("failed");
  });
});
