import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildChatbotTools } from "../../../src/agents/chatbot/tools";
import { buildChatbotTool } from "../../../src/agents/shared/chatbot-tool";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { hiddenToolNames } from "../../../src/agents/shared/policy-tool-gate";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";
import { recallsIn } from "../../../src/services/recall/recall";

/**
 * The team's structured data is its people's. Someone who takes part in a
 * project of the team, or reads a chat shared with them from it, works
 * without the tools that read or change it: pruned from every menu, and
 * refused when the model calls one by name anyway — the SDK runs any tool of
 * the registry, active or not.
 */

const ctx = (outsideTeam: boolean) =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
    outsideTeam,
  });

/** The two sub-agent tools would drag in the whole agent graph. */
const stub = {
  description: "stub",
  category: "domain" as const,
  searchHint: "",
};

const registry = () =>
  buildChatbotTools({
    dispatchAgent: { ...stub, category: "core" as const } as never,
    buildPage: stub as never,
  });

const TEAM_DATA_TOOLS = [
  "describeCollection",
  "getRecord",
  "listRecords",
  "manageCollection",
  "manageField",
  "manageLink",
  "manageRecord",
  "manageSync",
  "querySql",
];

describe("the team's data tools", () => {
  test("are the collection, record and SQL tools, and nothing else", () => {
    const flagged = Object.entries(registry())
      .filter(([, tool]) => (tool as { teamData?: boolean }).teamData === true)
      .map(([name]) => name)
      .sort();
    expect(flagged).toEqual(TEAM_DATA_TOOLS);
  });

  test("are withheld from someone outside the team, and only from them", () => {
    const tools = registry();
    expect([...hiddenToolNames(ctx(false), tools)]).toEqual([]);
    expect([...hiddenToolNames(ctx(true), tools)].sort()).toEqual(
      TEAM_DATA_TOOLS,
    );
  });

  test("refuse a call by name from someone outside the team", async () => {
    let ran = 0;
    const tool = buildChatbotTool({
      category: "domain",
      searchHint: "",
      description: "reads the team's data",
      inputSchema: z.object({}),
      teamData: true,
      execute: async () => {
        ran += 1;
        return { rows: 3 };
      },
    });
    const call = async (outsideTeam: boolean): Promise<unknown> => {
      const execute = tool.execute;
      if (!execute) throw new Error("tool has no execute fn");
      return await Promise.resolve(
        execute(
          {},
          { toolCallId: "call-test", messages: [], context: ctx(outsideTeam) },
        ),
      );
    };

    expect(await call(true)).toMatchObject({
      code: TOOL_ERROR_CODES.TEAM_DATA_UNAVAILABLE,
    });
    expect(ran).toBe(0);
    expect(await call(false)).toEqual({ rows: 3 });
    expect(ran).toBe(1);
  });
});

describe("pre-turn recall", () => {
  test("has nowhere to look for someone outside the team, outside a project", () => {
    expect(recallsIn({})).toBe(true);
    expect(recallsIn({ projectId: "project-1" })).toBe(true);
    expect(recallsIn({ projectId: "project-1", outsideTeam: true })).toBe(true);
    expect(recallsIn({ outsideTeam: true })).toBe(false);
  });
});
