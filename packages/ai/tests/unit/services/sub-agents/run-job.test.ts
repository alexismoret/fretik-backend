import { beforeEach, describe, expect, test } from "bun:test";
import type { SubAgentJobData } from "../../../../src/services/sub-agents/queue";
import { mockModule } from "../../../lib/mock-module";

/**
 * One sub-agent, run by a queue worker: what it reports, and how every way it
 * can end lands on its task row.
 *
 * What this pins, each one a way the feature fails silently:
 *  - the report — summary, deliverables, why it stopped short — lands on the
 *    row WITH the terminal status, then wakes the conversation: the report
 *    has nowhere else to live;
 *  - the card sees live progress while it works;
 *  - a stop asked while it waited in the queue means it never starts;
 *  - a stop by the assistant, or by the Stop of the answer that launched it,
 *    settles QUIETLY — consumed, no resume — while the user's own stop on its
 *    row still reaches the assistant;
 *  - a job the queue restarts after its row settled does nothing;
 *  - a crash still settles, and never leaves the heartbeat behind.
 *
 * Doubled at the process boundaries: the task registry (Postgres), the
 * heartbeat, the resume signal and the stop channel (Redis), the kernel
 * release (E2B). The sub-agent is a stub standing in for the model.
 */

interface Row {
  ref: string;
  status: string;
  metadata: { subAgent?: Record<string, unknown> } | null;
}
interface Completed {
  ref: string;
  status: string;
  consume?: boolean;
  metadata?: {
    subAgent?: Record<string, unknown> & {
      result?: Record<string, unknown>;
    };
  };
}

let row: Row | undefined;
const completed: Completed[] = [];
const patched: Record<string, unknown>[] = [];
const resumed: string[] = [];
const heartbeats = { beat: 0, cleared: 0 };
const channels = new Map<string, (message: string) => void>();

await mockModule("@fretik/shared/services/conversation-tasks/list", {
  listSubAgentTasks: async () => (row === undefined ? [] : [row]),
});
await mockModule("@fretik/shared/services/conversation-tasks/complete", {
  completeConversationTask: async (params: Completed) => {
    completed.push(params);
    return { conversationId: "conv-1", transitioned: true };
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/patch-metadata", {
  patchConversationTaskMetadata: async (params: {
    metadata: { subAgent: Record<string, unknown> };
  }) => {
    patched.push(structuredClone(params.metadata.subAgent));
  },
});
await mockModule("@fretik/shared/lib/sub-agent-heartbeat", {
  beatSubAgent: async () => {
    heartbeats.beat += 1;
  },
  clearSubAgentHeartbeat: async () => {
    heartbeats.cleared += 1;
  },
});
await mockModule("@fretik/shared/lib/conversation-task-resume", {
  publishConversationTaskResume: async (conversationId: string) => {
    resumed.push(conversationId);
  },
});
await mockModule("@fretik/shared/lib/redis-subscriber", {
  subscribeChannel: (channel: string, listener: (message: string) => void) => {
    channels.set(channel, listener);
    return () => channels.delete(channel);
  },
});
await mockModule("@fretik/shared/services/e2b/release-python-context", {
  releasePythonContext: async () => undefined,
});

const { runSubAgentJob } =
  await import("../../../../src/services/sub-agents/run-job");
const { getProfileForRole } =
  await import("../../../../src/lib/model-registry/resolve");

interface StubCall {
  toolName: string;
  caption?: string;
  output?: unknown;
}

/**
 * A stand-in for the sub-agent: reports each call through the SDK callbacks
 * the runner listens to, then finishes the way it is told — or, with `hold`,
 * waits for its abort signal.
 */
const stubAgent = (script: {
  calls?: StubCall[];
  text?: string;
  finishReason?: string;
  hold?: boolean;
  /** Keep working this long after the calls, before answering. */
  lingerMs?: number;
  throws?: boolean;
  onGenerate?: () => void;
}) => ({
  version: "agent-v1" as const,
  id: "stub",
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async (params: {
    abortSignal?: AbortSignal;
    onToolExecutionStart?: (event: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
    }) => void;
    onToolExecutionEnd?: (event: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
      toolOutput: { type: string; output?: unknown };
    }) => void;
  }) => {
    script.onGenerate?.();
    for (const [index, call] of (script.calls ?? []).entries()) {
      const toolCall = {
        toolCallId: `inner_${index.toString()}`,
        toolName: call.toolName,
        input: call.caption === undefined ? {} : { caption: call.caption },
      };
      params.onToolExecutionStart?.({ toolCall });
      await new Promise((resolve) => setTimeout(resolve, 1));
      params.onToolExecutionEnd?.({
        toolCall,
        toolOutput: { type: "tool-result", output: call.output ?? { ok: 1 } },
      });
    }
    if (script.throws) throw new Error("upstream exploded");
    if (script.lingerMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, script.lingerMs));
    }
    if (script.hold) {
      await new Promise<void>((_resolve, reject) => {
        params.abortSignal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    return {
      text: script.text ?? "",
      finishReason: script.finishReason ?? "stop",
      steps: [],
      responseMessages: [],
    };
  },
});

const job = (): SubAgentJobData => ({
  agentId: "agent-1",
  conversationId: "conv-1",
  organizationId: "org-1",
  teamId: "team-1",
  userId: "user-1",
  description: "Compare offers",
  profileKey: getProfileForRole("chat").key,
  brief: "<task>\nCompare the three offers\n</task>",
  callOptions: {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId: "conv-1",
    traceId: "subagent-agent-1",
    delegateRunId: "agent-1",
  },
});

const run = (
  primary: ReturnType<typeof stubAgent>,
  fallback: ReturnType<typeof stubAgent> = primary,
) =>
  runSubAgentJob(job(), {
    resolve: () => ({
      primary: primary as never,
      fallback: fallback as never,
      contextCeiling: 100_000,
      profile: getProfileForRole("chat"),
    }),
  });

const settled = (): Completed => {
  const last = completed.at(-1);
  if (last === undefined) throw new Error("the task was never settled");
  return last;
};
const resultOf = (): Record<string, unknown> =>
  settled().metadata?.subAgent?.result ?? {};

beforeEach(() => {
  row = {
    ref: "agent-1",
    status: "pending",
    metadata: { subAgent: { toolCallId: "call_1", turnId: "turn-1" } },
  };
  completed.length = 0;
  patched.length = 0;
  resumed.length = 0;
  heartbeats.beat = 0;
  heartbeats.cleared = 0;
  channels.clear();
});

describe("a sub-agent's run", () => {
  test("a finished run lands its report on the row, then wakes the conversation", async () => {
    await run(
      stubAgent({
        calls: [
          { toolName: "searchKnowledge", caption: "Reading the contracts" },
          {
            toolName: "python",
            caption: "Building the comparison",
            output: {
              artifacts: [
                { path: "outputs/comparison.xlsx" },
                { path: "outputs/results/call-0.png" },
              ],
            },
          },
        ],
        text: "Offer B is 12% cheaper.",
      }),
    );
    expect(settled().status).toBe("succeeded");
    expect(settled().consume).toBe(false);
    expect(resultOf().status).toBe("completed");
    expect(resultOf().summary).toBe("Offer B is 12% cheaper.");
    // Deliverables only — not the kernel's display captures.
    expect(resultOf().files).toEqual(["outputs/comparison.xlsx"]);
    expect(resultOf().toolCalls).toBe(2);
    // What was known at launch survives the settle.
    expect(settled().metadata?.subAgent?.toolCallId).toBe("call_1");
    expect(resumed).toEqual(["conv-1"]);
    // Never outlived by its proof of life.
    expect(heartbeats.beat).toBeGreaterThan(0);
    expect(heartbeats.cleared).toBe(1);
    expect(channels.size).toBe(0);
  });

  test("the card sees it picked up, then its calls as they happen", async () => {
    // Writes are throttled to one per 1.5 s, the last one trailing: a run that
    // outlasts the window shows its latest call before it ends.
    await run(
      stubAgent({
        calls: [{ toolName: "searchWeb", caption: "Searching the web" }],
        lingerMs: 1_700,
        text: "Done.",
      }),
    );
    // Picked up: a start time, before any call — the card leaves "queued".
    expect(typeof patched[0]?.startedAt).toBe("number");
    expect(patched[0]?.step).toBe(0);
    const activity = patched
      .flatMap((state) => (state.activity as { caption?: string }[]) ?? [])
      .map((entry) => entry.caption);
    expect(activity).toContain("Searching the web");
  });

  test("a run cut by its step budget is partial, one with no report is failed", async () => {
    await run(
      stubAgent({ text: "Two of three compared.", finishReason: "tool-calls" }),
    );
    expect(settled().status).toBe("succeeded");
    expect(resultOf().status).toBe("partial");
    expect(resultOf().reason).toBe("step_budget");

    await run(stubAgent({ text: "", finishReason: "stop" }));
    expect(settled().status).toBe("failed");
    expect(resultOf().reason).toBe("empty");
    expect(String(resultOf().summary).length).toBeGreaterThan(0);
  });

  test("an empty run gets one retry on the fallback model", async () => {
    await run(
      stubAgent({ text: "", finishReason: "length" }),
      stubAgent({ text: "Recovered report." }),
    );
    expect(resultOf().status).toBe("completed");
    expect(resultOf().summary).toBe("Recovered report.");
  });

  test("a crash still settles as failed, and still wakes the conversation", async () => {
    await run(stubAgent({ throws: true }));
    expect(settled().status).toBe("failed");
    expect(resultOf().reason).toBe("interrupted");
    expect(resumed).toEqual(["conv-1"]);
    expect(heartbeats.cleared).toBe(1);
  });

  test("a job restarted after its row settled does nothing", async () => {
    row = { ref: "agent-1", status: "succeeded", metadata: null };
    let generated = false;
    await run(
      stubAgent({
        onGenerate: () => {
          generated = true;
        },
      }),
    );
    expect(generated).toBe(false);
    expect(completed.length).toBe(0);
  });
});

describe("stopping a sub-agent", () => {
  test("a stop asked while it queued means it never starts", async () => {
    row = {
      ref: "agent-1",
      status: "pending",
      metadata: { subAgent: { stopRequested: "user" } },
    };
    let generated = false;
    await run(
      stubAgent({
        onGenerate: () => {
          generated = true;
        },
      }),
    );
    expect(generated).toBe(false);
    expect(settled().status).toBe("canceled");
    expect(resultOf().reason).toBe("stopped");
    // The user's own stop still reaches the assistant.
    expect(settled().consume).toBe(false);
    expect(resumed).toEqual(["conv-1"]);
  });

  test("a stop by the assistant mid-run settles quietly, with what it had done", async () => {
    const running = run(
      stubAgent({
        calls: [{ toolName: "searchWeb", caption: "Searching the web" }],
        hold: true,
      }),
    );
    // Let it reach its first call, then stop it the way the API does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    channels.get("fretik-sub-agent-abort:agent-1")?.("parent");
    await running;
    expect(settled().status).toBe("canceled");
    expect(settled().metadata?.subAgent?.stopRequested).toBe("parent");
    expect(resultOf().reason).toBe("stopped");
    expect(resultOf().toolCalls).toBe(1);
    // News to nobody: consumed, and the conversation is not woken.
    expect(settled().consume).toBe(true);
    expect(resumed).toEqual([]);
  });

  test("the Stop of the answer that launched it settles quietly too", async () => {
    const running = run(stubAgent({ hold: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    channels.get("fretik-sub-agent-abort:agent-1")?.("turn");
    await running;
    expect(settled().status).toBe("canceled");
    expect(settled().consume).toBe(true);
    expect(resumed).toEqual([]);
  });
});
