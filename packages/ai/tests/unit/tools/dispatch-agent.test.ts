import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import type { SubAgentJobData } from "../../../src/services/sub-agents/queue";
import { mockModule } from "../../lib/mock-module";

/**
 * `dispatchAgent` — the launch: what a sub-agent is given, and what the parent
 * gets back before any of the work is done.
 *
 * What this pins, each one a way the feature fails silently:
 *  - the wait is REGISTERED before the job exists — otherwise a turn ending
 *    right after sees nothing pending and nobody is ever resumed, and a
 *    worker runs a job with no row to settle;
 *  - the job carries everything that decides what the run may do (the team's
 *    tool policies, the run's autonomy, the apps), because it runs on
 *    whichever replica picks it up, with nothing of the parent's context;
 *  - it runs on the parent's model, or the team's Fast pick on request;
 *  - its brief knows the date and the team's context — a sub-agent sees
 *    nothing of the conversation;
 *  - the budgets refuse before anything is registered, and a queue that
 *    cannot be reached leaves no row waiting.
 *
 * Doubled at the process boundaries: the task registry (Postgres), the queue
 * (Redis) and the skill reader (the sandbox).
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
  consume?: boolean;
}

const events: string[] = [];
const registered: Registered[] = [];
const completed: Completed[] = [];
const jobs: SubAgentJobData[] = [];
let openRows: { status: string }[] = [];
let queueDown = false;
const skillReads: string[] = [];

await mockModule("@fretik/shared/services/conversation-tasks/register", {
  registerConversationTask: async (params: Registered) => {
    events.push("register");
    registered.push(params);
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/complete", {
  completeConversationTask: async (params: Completed) => {
    completed.push(params);
    return { conversationId: "conv-1", transitioned: true };
  },
});
await mockModule("@fretik/shared/services/conversation-tasks/list", {
  listOpenSubAgentTasks: async () => openRows,
});
await mockModule("../../../src/services/sub-agents/queue", {
  enqueueSubAgent: async (job: SubAgentJobData) => {
    if (queueDown) throw new Error("connection refused");
    events.push("enqueue");
    jobs.push(job);
  },
});
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

const tool = createDispatchAgentTool();

const dispatch = async (
  input: Record<string, unknown> = {},
  ctx: AgentRuntimeContext = parentCtx(),
  toolCallId = "call_1",
): Promise<Record<string, unknown>> => {
  const execute = tool.execute;
  if (execute === undefined) throw new Error("dispatchAgent has no execute");
  const output: unknown = await execute(
    {
      task: "Compare the three offers",
      description: "Compare offers",
      ...input,
    },
    { toolCallId, messages: [], context: wrapRuntimeContext(ctx) } as never,
  );
  return output as Record<string, unknown>;
};

const lastJob = (): SubAgentJobData => {
  const job = jobs.at(-1);
  if (job === undefined) throw new Error("nothing was queued");
  return job;
};

beforeEach(() => {
  resetDelegationSlots();
  events.length = 0;
  registered.length = 0;
  completed.length = 0;
  jobs.length = 0;
  skillReads.length = 0;
  openRows = [];
  queueDown = false;
});

afterEach(() => {
  delete process.env.DISPATCH_AGENT_MAX_PER_TURN;
  delete process.env.DISPATCH_AGENT_MAX_OPEN;
});

describe("dispatchAgent — the launch", () => {
  test("answers at once, after registering the wait and then queuing the run", async () => {
    const ctx = parentCtx({ traceId: "turn-1.step" });
    const output = await dispatch({ model: "fast" }, ctx);
    expect(output.status).toBe("started");
    expect(typeof output.agentId).toBe("string");
    expect(events).toEqual(["register", "enqueue"]);
    const row = registered[0];
    expect(row?.ref).toBe(String(output.agentId));
    expect(row?.kind).toBe("sub_agent");
    expect(row?.title).toBe("Compare offers");
    expect(row?.metadata?.subAgent).toEqual({
      launchedByUserId: "user-1",
      toolCallId: "call_1",
      model: "fast",
      // The turn's ROOT: what the Stop of that answer cascades by.
      turnId: "turn-1",
    });
    expect(lastJob().agentId).toBe(String(output.agentId));
    // `manageAgents` joins the parent's tools from its next step.
    expect(ctx.dynamicToolManager.isActivated("manageAgents")).toBe(true);
  });

  test("a chat turn is told to end its turn to wait, a workflow turn to `wait`", async () => {
    const chat = await dispatch();
    expect(String(chat.next)).toContain("end your turn");
    const run = await dispatch({}, parentCtx({ workflowRunId: "run-1" }));
    expect(String(run.next)).toContain("`manageAgents` `wait`");
  });
});

describe("dispatchAgent — what the sub-agent is given", () => {
  test("it inherits everything that decides what it may do", async () => {
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
    const output = await dispatch(
      {},
      parentCtx({
        toolPolicies: { webFetch: "blocked" },
        reasoningLevel: "high",
        workflowAutonomy: "approval_required",
        externalAppConnections: connections,
      }),
    );
    const options = lastJob().callOptions;
    expect(options.toolPolicies).toEqual({ webFetch: "blocked" });
    expect(options.reasoningLevel).toBe("high");
    expect(options.workflowAutonomy).toBe("approval_required");
    expect(options.externalAppConnections).toEqual(connections);
    // Its own run id (its own Python kernel, its sandbox calls read-only), and
    // a trace id of its own with NO dot: its own provider lane and ledger key,
    // never folded into a turn that has usually ended when it finishes.
    expect(options.delegateRunId).toBe(String(output.agentId));
    expect(options.traceId).toBe(`subagent-${String(output.agentId)}`);
    expect(options.traceId).not.toContain(".");
    // The job is data: it runs on whichever replica picks it up.
    expect(JSON.parse(JSON.stringify(lastJob()))).toEqual(lastJob());
  });

  test("it runs on the model the parent is serving on", async () => {
    await dispatch();
    expect(lastJob().profileKey).toBe(getProfileForRole("chat").key);
  });

  test("`fast` runs it on the team's Fast pick, at that model's own depth", async () => {
    await dispatch(
      { model: "fast" },
      parentCtx({ fastProfileKey: "fast-model", reasoningLevel: "high" }),
    );
    expect(lastJob().profileKey).toBe("fast-model");
    // The parent's depth was chosen against the PARENT's model; handed to
    // another profile it could name a rung that model does not have.
    expect(lastJob().callOptions.reasoningLevel).toBeUndefined();
  });

  test("`fast` with no Fast pick in the context stays on the parent's model", async () => {
    await dispatch({ model: "fast" });
    expect(lastJob().profileKey).toBe(getProfileForRole("chat").key);
  });

  test("its brief carries the date, the team's context and the task", async () => {
    await dispatch(
      {},
      parentCtx({
        chatbotContextManifest: "Always quote amounts excluding tax.",
        enabledSkillsBlock: "- **xlsx** — spreadsheets",
        teamCollectionsBlock: "- **client** (view c_client)",
        externalAppsBlock: "- crm (id: conn-1, CRM)",
      }),
    );
    const brief = lastJob().brief;
    expect(brief).toContain("<current_date>");
    expect(brief).toContain("Europe/Paris");
    expect(brief).toContain("Always quote amounts excluding tax.");
    expect(brief).toContain("<skills_catalog>");
    expect(brief).toContain("<team_collections>");
    expect(brief).toContain("<external_apps>");
    expect(brief).toContain("<task>\nCompare the three offers\n</task>");
  });

  test("an empty block is left out rather than rendered empty", async () => {
    await dispatch({}, parentCtx({ teamCollectionsBlock: "   " }));
    expect(lastJob().brief).not.toContain("<team_collections>");
  });

  test("the skills it is handed arrive in full; a missing one says so", async () => {
    await dispatch({ skills: ["xlsx", "nope"] });
    expect(skillReads.sort()).toEqual([
      "skills/nope/SKILL.md",
      "skills/xlsx/SKILL.md",
    ]);
    expect(lastJob().brief).toContain("Build workbooks with openpyxl.");
    expect(lastJob().brief).toContain('<skill name="nope">Not available');
  });
});

describe("dispatchAgent — limits", () => {
  test("a dispatch over the turn's budget is refused before anything is registered", async () => {
    process.env.DISPATCH_AGENT_MAX_PER_TURN = "1";
    await dispatch({}, parentCtx(), "call_1");
    const refused = await dispatch({}, parentCtx(), "call_2");
    expect(refused.code).toBe("DELEGATION_LIMIT");
    expect(registered.length).toBe(1);
    expect(jobs.length).toBe(1);
  });

  test("a conversation with too many sub-agents running is refused", async () => {
    process.env.DISPATCH_AGENT_MAX_OPEN = "2";
    // Settled rows awaiting their reader do not count — only running ones.
    openRows = [
      { status: "pending" },
      { status: "pending" },
      { status: "succeeded" },
    ];
    const refused = await dispatch();
    expect(refused.code).toBe("DELEGATION_LIMIT");
    expect(registered.length).toBe(0);
  });

  test("no conversation, no sub-agent", async () => {
    const refused = await dispatch(
      {},
      parentCtx({ conversationId: undefined }),
    );
    expect(refused.code).toBe("NO_CONVERSATION");
    expect(registered.length).toBe(0);
  });

  test("a queue it cannot reach leaves no wait behind, and says so", async () => {
    queueDown = true;
    const refused = await dispatch();
    expect(refused.code).toBe("INTERNAL_ERROR");
    // Settled AND consumed: the turn handles the error inline, so nothing
    // must wake the conversation to hear it again.
    expect(completed).toEqual([
      {
        kind: "sub_agent",
        ref: String(registered[0]?.ref),
        status: "failed",
        consume: true,
      },
    ]);
  });
});
