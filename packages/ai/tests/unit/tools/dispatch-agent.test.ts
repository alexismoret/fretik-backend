import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { mockModule } from "../../lib/mock-module";

/**
 * `dispatchAgent` end to end, with the sub-agent stubbed: what the sub-agent
 * is given, what it may do, and what comes back.
 *
 * Every test here pins a defect the redesign fixed — each one was live:
 *  - the team's tool policies and the turn's reasoning depth never reached a
 *    sub-agent (a `blocked` tool was usable through one);
 *  - the "primary" sub-agent ran the code default, not the parent's model;
 *  - the sub-agent knew nothing but the task string — not even the date;
 *  - parallel sub-agents shared one provider lane;
 *  - the fallback agent was built and never used;
 *  - the card showed a spinner until the end, and the result was free text.
 *
 * The skill reader is the one boundary doubled: everything else runs as in
 * production, the stub standing in for the model.
 */

const skillReads: string[] = [];
await mockModule("../../../src/skills/read-skill-file", {
  readSkillWorkspaceFile: async (_conversationId: string, path: string) => {
    skillReads.push(path);
    return path === "skills/xlsx/SKILL.md"
      ? "# xlsx\n\nBuild workbooks with openpyxl."
      : null;
  },
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

interface StubCall {
  toolName: string;
  caption?: string;
  output?: unknown;
  failed?: boolean;
}

interface Captured {
  messages: { role: string; content: unknown }[];
  options: Record<string, unknown>;
}

/**
 * A stand-in for the sub-agent: reports each call's start and end through the
 * SDK callbacks the helper listens to, then finishes the way it is told.
 */
const stubAgent = (
  script: {
    calls?: StubCall[];
    text: string;
    finishReason: string;
  },
  captured: Captured[],
) => ({
  version: "agent-v1" as const,
  id: "stub",
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async (params: {
    messages: { role: string; content: unknown }[];
    options: Record<string, unknown>;
    onToolExecutionStart?: (event: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
    }) => void;
    onToolExecutionEnd?: (event: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
      toolOutput: { type: string; output?: unknown };
    }) => void;
  }) => {
    captured.push({ messages: params.messages, options: params.options });
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
        toolOutput: call.failed
          ? { type: "tool-error" }
          : { type: "tool-result", output: call.output ?? { ok: true } },
      });
    }
    return {
      text: script.text,
      finishReason: script.finishReason,
      steps: [],
      responseMessages: [],
    };
  },
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

const build = (
  primary: ReturnType<typeof stubAgent>,
  fallback: ReturnType<typeof stubAgent> = primary,
  resolvedKeys: string[] = [],
) =>
  createDispatchAgentTool({
    resolve: (profileKey) => {
      resolvedKeys.push(profileKey);
      return {
        primary: primary as never,
        fallback: fallback as never,
        contextCeiling: 100_000,
      };
    },
  });

const drain = async (value: unknown): Promise<unknown[]> => {
  if (typeof value !== "object" || value === null) return [value];
  if (!(Symbol.asyncIterator in value)) {
    return [await Promise.resolve(value)];
  }
  const collected: unknown[] = [];
  for await (const item of value as AsyncIterable<unknown>) {
    collected.push(item);
  }
  return collected;
};

const dispatch = async (
  tool: ReturnType<typeof build>,
  input: Record<string, unknown>,
  ctx: AgentRuntimeContext = parentCtx(),
  toolCallId = "call_1",
): Promise<unknown[]> => {
  const execute = tool.execute;
  if (execute === undefined) throw new Error("dispatchAgent has no execute");
  return drain(
    execute(
      {
        task: "Compare the three offers",
        description: "Compare offers",
        ...input,
      },
      { toolCallId, messages: [], context: wrapRuntimeContext(ctx) } as never,
    ),
  );
};

const resultOf = (yielded: unknown[]): Record<string, unknown> => {
  const last = yielded.at(-1);
  if (typeof last !== "object" || last === null) throw new Error("no result");
  return last as Record<string, unknown>;
};

beforeEach(() => {
  resetDelegationSlots();
  skillReads.length = 0;
});

afterEach(() => {
  delete process.env.DISPATCH_AGENT_MAX_PER_TURN;
});

describe("dispatchAgent — what the sub-agent is given", () => {
  test("it inherits everything that decides what it may do", async () => {
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
    );
    const connections = [
      {
        id: "conn-1",
        providerKey: "crm",
        displayName: "CRM",
        scope: "team" as const,
        categories: ["crm"],
        options: null,
      },
    ];
    await dispatch(
      tool,
      {},
      parentCtx({
        toolPolicies: { webFetch: "blocked" },
        reasoningLevel: "high",
        workflowAutonomy: "approval_required",
        externalAppConnections: connections,
      }),
    );
    const options = captured[0]?.options;
    expect(options?.toolPolicies).toEqual({ webFetch: "blocked" });
    expect(options?.reasoningLevel).toBe("high");
    expect(options?.workflowAutonomy).toBe("approval_required");
    expect(options?.externalAppConnections).toEqual(connections);
    // Its own run id (its own Python kernel, its sandbox calls read-only) and
    // its own trace id under the turn's root (its own provider lane).
    expect(options?.delegateRunId).toBe("call_1");
    expect(options?.traceId).toBe("turn-1.sub.call_1");
  });

  test("it runs on the model the parent is serving on", async () => {
    const resolved: string[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, []),
      undefined,
      resolved,
    );
    await dispatch(tool, {});
    expect(resolved.length).toBeGreaterThan(0);
    for (const key of resolved) {
      expect(key).toBe(getProfileForRole("chat").key);
    }
  });

  test("`fast` runs it on the team's Fast pick, at that model's own depth", async () => {
    const resolved: string[] = [];
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
      undefined,
      resolved,
    );
    await dispatch(
      tool,
      { model: "fast" },
      parentCtx({ fastProfileKey: "fast-model", reasoningLevel: "high" }),
    );
    expect(resolved.length).toBeGreaterThan(0);
    for (const key of resolved) expect(key).toBe("fast-model");
    // The parent's depth was chosen against the PARENT's model; handed to
    // another profile it could name a rung that model does not have.
    expect(captured[0]?.options.reasoningLevel).toBeUndefined();
  });

  test("`fast` with no Fast pick in the context stays on the parent's model", async () => {
    const resolved: string[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, []),
      undefined,
      resolved,
    );
    await dispatch(tool, { model: "fast" });
    for (const key of resolved) {
      expect(key).toBe(getProfileForRole("chat").key);
    }
  });

  test("its brief carries the date, the team's context and the task", async () => {
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
    );
    await dispatch(
      tool,
      {},
      parentCtx({
        chatbotContextManifest: "Always quote amounts excluding tax.",
        enabledSkillsBlock: "- **xlsx** — spreadsheets",
        teamCollectionsBlock: "- **client** (view c_client)",
        externalAppsBlock: "- crm (id: conn-1, CRM)",
      }),
    );
    const brief = String(captured[0]?.messages[0]?.content);
    expect(brief).toContain("<current_date>");
    expect(brief).toContain("Europe/Paris");
    expect(brief).toContain("Always quote amounts excluding tax.");
    expect(brief).toContain("<skills_catalog>");
    expect(brief).toContain("<team_collections>");
    expect(brief).toContain("<external_apps>");
    expect(brief).toContain("<task>\nCompare the three offers\n</task>");
  });

  test("an empty block is left out rather than rendered empty", async () => {
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
    );
    await dispatch(tool, {}, parentCtx({ teamCollectionsBlock: "   " }));
    expect(String(captured[0]?.messages[0]?.content)).not.toContain(
      "<team_collections>",
    );
  });

  test("the skills it is handed arrive in full; a missing one says so", async () => {
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
    );
    await dispatch(tool, { skills: ["xlsx", "nope"] });
    const brief = String(captured[0]?.messages[0]?.content);
    expect(skillReads.sort()).toEqual([
      "skills/nope/SKILL.md",
      "skills/xlsx/SKILL.md",
    ]);
    expect(brief).toContain("Build workbooks with openpyxl.");
    expect(brief).toContain('<skill name="nope">Not available');
  });
});

describe("dispatchAgent — what comes back", () => {
  test("a finished run reports its summary, deliverables and activity", async () => {
    const tool = build(
      stubAgent(
        {
          calls: [
            { toolName: "searchKnowledge", caption: "Reading the contracts" },
            {
              toolName: "python",
              caption: "Building the comparison",
              output: {
                artifacts: [
                  { path: "outputs/comparison.xlsx" },
                  { path: "outputs/results/call-0.png" },
                  { path: "outputs/persisted/big.txt" },
                ],
              },
            },
            {
              toolName: "transform",
              output: { outputPath: "/workspace/outputs/summary.md" },
            },
            {
              toolName: "querySql",
              caption: "Totalling the invoices",
              output: { error: "relation does not exist", code: "SQL_ERROR" },
            },
          ],
          text: "Offer B is 12% cheaper.",
          finishReason: "stop",
        },
        [],
      ),
    );
    const result = resultOf(await dispatch(tool, {}));
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Offer B is 12% cheaper.");
    // Deliverables only — not the kernel's display captures nor the overflow
    // of an oversized result.
    expect(result.files).toEqual([
      "outputs/comparison.xlsx",
      "outputs/summary.md",
    ]);
    expect(result.toolCalls).toBe(4);
    expect(result.reason).toBeUndefined();
    expect(result.activity).toEqual([
      {
        tool: "searchKnowledge",
        caption: "Reading the contracts",
        state: "done",
      },
      { tool: "python", caption: "Building the comparison", state: "done" },
      { tool: "transform", state: "done" },
      // A tool returns `{ error }` rather than throwing: still a failure.
      { tool: "querySql", caption: "Totalling the invoices", state: "error" },
    ]);
  });

  test("a run cut by its step budget is partial, and says why", async () => {
    const tool = build(
      stubAgent(
        { text: "Two of three offers compared.", finishReason: "tool-calls" },
        [],
      ),
    );
    const result = resultOf(await dispatch(tool, {}));
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("step_budget");
    expect(result.summary).toBe("Two of three offers compared.");
  });

  test("a run that wrote no report is failed, never an empty summary", async () => {
    const tool = build(stubAgent({ text: "", finishReason: "stop" }, []));
    const result = resultOf(await dispatch(tool, {}));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("empty");
    expect(String(result.summary).length).toBeGreaterThan(0);
  });

  test("an empty run gets one retry on the fallback model", async () => {
    // The fallback set was built and never wired: a reasoning-only zombie
    // came back as nothing, and the parent had to start over.
    const fallbackCalls: Captured[] = [];
    const tool = build(
      stubAgent({ text: "", finishReason: "length" }, []),
      stubAgent(
        { text: "Recovered report.", finishReason: "stop" },
        fallbackCalls,
      ),
    );
    const result = resultOf(await dispatch(tool, {}));
    expect(fallbackCalls.length).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Recovered report.");
  });

  test("the card gets live progress, and the result comes last", async () => {
    const tool = build(
      stubAgent(
        {
          calls: [
            { toolName: "searchWeb", caption: "Searching the web" },
            { toolName: "webFetch", caption: "Reading the page" },
          ],
          text: "Done.",
          finishReason: "stop",
        },
        [],
      ),
    );
    const yielded = await dispatch(tool, {});
    const snapshots = yielded
      .slice(0, -1)
      .map((value) => Reflect.get(Object(value), "progress"));
    expect(snapshots.length).toBeGreaterThan(0);
    const latest = snapshots.at(-1) as {
      step: number;
      startedAt: number;
      activity: { caption?: string }[];
    };
    expect(typeof latest.startedAt).toBe("number");
    expect(latest.activity.at(-1)?.caption).toBe("Reading the page");
    // The model reads the LAST yield; it must be the result, never a snapshot.
    expect("progress" in resultOf(yielded)).toBe(false);
    expect(resultOf(yielded).status).toBe("completed");
  });
});

describe("dispatchAgent — limits", () => {
  test("a dispatch over the turn's budget is refused before anything runs", async () => {
    process.env.DISPATCH_AGENT_MAX_PER_TURN = "1";
    const captured: Captured[] = [];
    const tool = build(
      stubAgent({ text: "ok", finishReason: "stop" }, captured),
    );
    await dispatch(tool, {}, parentCtx(), "call_1");
    const refused = resultOf(await dispatch(tool, {}, parentCtx(), "call_2"));
    expect(refused.code).toBe("DELEGATION_LIMIT");
    expect(captured.length).toBe(1);
  });
});
