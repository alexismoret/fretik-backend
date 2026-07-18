import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { chatbotAgentSet } from "../../../src/agents/chatbot/index";
import { type ChatbotTools } from "../../../src/agents/chatbot/tools";
import {
  DynamicToolManager,
  replayActivationFromHistory,
} from "../../../src/agents/shared/dynamic-tools";
import {
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * End-to-end integration test for Progressive Disclosure.
 *
 * Exercises the exact same glue the chatbot agent runs at request
 * time — `buildChatbotTools` → `searchTools.execute` →
 * `DynamicToolManager` mutation → `prepareStep`-equivalent activeTools
 * computation → next-step visibility.
 *
 * This is the regression gate for the Phase 7.5 → D.1.3 bug that
 * shipped the refactor without teaching the model the activation
 * protocol (see `cozy-tickling-crane.md` plan). Any future change
 * that breaks the gateway → manager → prepareStep chain will fail
 * here before it reaches a live model.
 *
 * Intentionally imports from `chatbot/tools.ts` (env-free) rather
 * than `chatbot/index.ts` which throws at import time when
 * `OPENROUTER_CHAT_MODEL` is missing. The `prepareStep` logic is
 * re-implemented inline as `computeActiveTools` — it's 4 lines and
 * mirrors `chatbotPrepareStep` in `chatbot/index.ts` exactly. The
 * duplication is intentional so the test cannot be silently broken
 * by an import-order change upstream.
 */

const EXPECTED_CORE_TOOL_NAMES: readonly string[] = [
  "searchKnowledge",
  "querySql",
  "searchWeb",
  "read",
  "extract",
  "vision",
  "python",
  "bash",
  "presentFiles",
  "searchTools",
  "memory",
  "askUserQuestion",
  "dispatchAgent",
];

const EXPECTED_DOMAIN_TOOL_NAMES: readonly string[] = [
  "listDocuments",
  "describeObjectType",
  "listObjects",
  "getObject",
  "manageRecord",
  "manageLink",
  "manageObjectType",
  "manageField",
  "searchIcons",
  "webFetch",
  "downloadDriveDocument",
  "uploadToDrive",
  "manageDrive",
  "listFolders",
  "createSkill",
  "updateSkill",
  "searchSkills",
  "installSkill",
  "manageWorkflow",
];

/**
 * Mirrors `chatbot/index.ts::chatbotPrepareStep` exactly. Returns the
 * same `activeTools` array the AI SDK would filter the tools map with
 * on each step.
 */
const computeActiveTools = (
  tools: ChatbotTools,
  manager: DynamicToolManager,
): string[] => {
  const coreNames: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "core") coreNames.push(name);
  }
  const activated = manager.getSnapshot().filter((n) => n in tools);
  return [...coreNames, ...activated];
};

/**
 * Build a runtime context wrapping the given manager, matching what
 * `agent-builder::prepareCall` assembles for a real request.
 */
const buildCtx = (
  manager: DynamicToolManager,
): { ctx: AgentRuntimeContext; branded: unknown } => {
  const ctx: AgentRuntimeContext = {
    organizationId: "org-1",
    teamId: "team-1",
    dynamicToolManager: manager,
    modelProfile: getProfileForRole("chat"),
  };
  return { ctx, branded: wrapRuntimeContext(ctx) };
};

/**
 * Invoke `searchTools.execute(...)` the same way the AI SDK does at
 * runtime. The tool is retrieved from the real chatbot tool set so
 * we catch any refactor that accidentally detaches it from the
 * chatbot registry.
 */
const runSearchTools = async (
  tools: ChatbotTools,
  ctx: AgentRuntimeContext,
  input: { query: string; max_results?: number },
): Promise<{ matches: string[] }> => {
  const searchTools = tools.searchTools;
  const execute = searchTools.execute;
  if (!execute) throw new Error("searchTools has no execute fn");
  // Derive the `ToolCallOptions` shape from the execute function
  // signature itself — same pattern as `tests/tools/search-tools.test.ts`
  // which avoids importing the deprecated top-level type name.
  type ExecOptions = Parameters<NonNullable<typeof searchTools.execute>>[1];
  const options: ExecOptions = {
    toolCallId: "call-test",
    messages: [],
    context: wrapRuntimeContext(ctx),
  };
  const result = await execute(input, options);
  if (typeof result !== "object" || result === null) {
    throw new Error(`searchTools returned non-object: ${String(result)}`);
  }
  if (!("matches" in result)) {
    throw new Error("searchTools result has no matches field");
  }
  const matches = result.matches;
  if (!Array.isArray(matches)) {
    throw new Error("searchTools result matches is not an array");
  }
  return { matches: matches.filter((m): m is string => typeof m === "string") };
};

describe("Chatbot Progressive Disclosure — end-to-end", () => {
  test("tool registry: 14 core tools + 19 domain tools, categories correct", () => {
    const tools = chatbotAgentSet.primary.tools;
    const coreNames = Object.entries(tools)
      .filter(([, t]) => t.category === "core")
      .map(([n]) => n);
    const domainNames = Object.entries(tools)
      .filter(([, t]) => t.category === "domain")
      .map(([n]) => n);
    expect(new Set(coreNames)).toEqual(new Set(EXPECTED_CORE_TOOL_NAMES));
    expect(new Set(domainNames)).toEqual(new Set(EXPECTED_DOMAIN_TOOL_NAMES));
  });

  test("step 0 with a fresh manager exposes core tools only — no domain leakage", () => {
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const active = computeActiveTools(tools, manager);
    expect(new Set(active)).toEqual(new Set(EXPECTED_CORE_TOOL_NAMES));
    for (const domainName of EXPECTED_DOMAIN_TOOL_NAMES) {
      expect(active).not.toContain(domainName);
    }
  });

  test("full cycle: searchTools select: → manager mutation → next step exposes the activated domain tool", async () => {
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const { ctx } = buildCtx(manager);

    // Step 0: domain tools hidden, only core exposed.
    const stepZero = computeActiveTools(tools, manager);
    expect(stepZero).not.toContain("listDocuments");
    expect(stepZero).toContain("searchTools");

    // Step 0 → model calls searchTools with exact name.
    const searchResult = await runSearchTools(tools, ctx, {
      query: "select:listDocuments",
    });
    expect(searchResult.matches).toEqual(["listDocuments"]);
    expect(manager.getSnapshot()).toEqual(["listDocuments"]);

    // Step 1: activeTools now contains the activated domain tool
    // alongside all core tools. This is what the AI SDK would feed
    // to the model on the next round-trip.
    const stepOne = computeActiveTools(tools, manager);
    expect(stepOne).toContain("listDocuments");
    for (const coreName of EXPECTED_CORE_TOOL_NAMES) {
      expect(stepOne).toContain(coreName);
    }
    // Other domain tools remain hidden until explicitly activated.
    // `listObjects` is a REAL registered domain tool (guarded below), so
    // this isolation assertion is meaningful — not a vacuous check against
    // a tool name that doesn't exist.
    expect(Object.keys(tools)).toContain("listObjects");
    expect(stepOne).not.toContain("listObjects");
    expect(stepOne).not.toContain("getObject");
  });

  test("full cycle: searchTools with free-form keyword query also activates", async () => {
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const { ctx } = buildCtx(manager);

    const searchResult = await runSearchTools(tools, ctx, {
      query: "documents team filter",
    });
    expect(searchResult.matches.length).toBeGreaterThan(0);
    expect(searchResult.matches).toContain("listDocuments");

    const stepOne = computeActiveTools(tools, manager);
    expect(stepOne).toContain("listDocuments");
  });

  test("exact-match fast path: bare `listDocuments` query activates without select: prefix", async () => {
    // Defends against the exact failure mode observed with MiniMax
    // M2.5: model passes a bare camelCase tool name and would
    // otherwise fall through to the scorer, which can't tokenize
    // the glued name. See search-tools.ts fast-path comment.
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const { ctx } = buildCtx(manager);

    const searchResult = await runSearchTools(tools, ctx, {
      query: "listDocuments",
    });
    expect(searchResult.matches).toEqual(["listDocuments"]);
    expect(manager.getSnapshot()).toEqual(["listDocuments"]);

    const stepOne = computeActiveTools(tools, manager);
    expect(stepOne).toContain("listDocuments");
  });

  test("replay from history: prior turn's activations are visible at step 0 of the next turn", () => {
    // Mirrors `agent-builder::prepareCall` behaviour for a follow-up
    // user message in the same conversation: the fresh manager is
    // rehydrated from the `searchTools` tool-result messages already
    // present in the history, so the model does NOT need to
    // re-discover tools it already used.
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const history: ModelMessage[] = [
      { role: "user", content: "list my documents" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-prior-0",
            toolName: "searchTools",
            input: { query: "select:listDocuments" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-prior-0",
            toolName: "searchTools",
            output: {
              type: "json",
              value: {
                matches: ["listDocuments"],
                query: "select:listDocuments",
                total_deferred_tools: 6,
              },
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "Here are your documents: ...",
      },
      { role: "user", content: "show me the 3rd one's extractions" },
    ];

    replayActivationFromHistory(manager, history, "searchTools");

    // Step 0 of the new turn already has listDocuments active.
    const stepZero = computeActiveTools(tools, manager);
    expect(stepZero).toContain("listDocuments");
    // Other (real) domain tools are still gated.
    expect(stepZero).not.toContain("listObjects");
  });

  test("replay is idempotent — running the same history twice does not duplicate activations", () => {
    const tools = chatbotAgentSet.primary.tools;
    const manager = new DynamicToolManager();
    const history: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "searchTools",
            output: {
              type: "json",
              value: {
                matches: ["listDocuments", "listObjects"],
                query: "select:listDocuments,listObjects",
                total_deferred_tools: 6,
              },
            },
          },
        ],
      },
    ];
    replayActivationFromHistory(manager, history, "searchTools");
    replayActivationFromHistory(manager, history, "searchTools");
    // Both are REAL registered domain tools, so the replay activates a
    // genuine multi-tool set (not phantom names the active-tools filter
    // would silently drop).
    expect(new Set(manager.getSnapshot())).toEqual(
      new Set(["listDocuments", "listObjects"]),
    );
    const active = computeActiveTools(tools, manager);
    // No duplicate entries either.
    expect(new Set(active).size).toBe(active.length);
  });
});
