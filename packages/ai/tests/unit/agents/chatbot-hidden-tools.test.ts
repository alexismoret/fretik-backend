import { describe, expect, test } from "bun:test";
import { chatbotHiddenToolNames } from "../../../src/agents/chatbot/hidden-tools";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * `checkAgents` is on the chat agent's list only while there is something for
 * it to report on. Two gates, both needed: a turn that STARTS with background
 * sub-agents open (the handler reads that), and a turn that LAUNCHES one
 * (the dispatch activates the tool mid-turn).
 */

const ctx = (
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  ...overrides,
});

describe("checkAgents gate", () => {
  test("hidden in a conversation with no background sub-agent", () => {
    expect(chatbotHiddenToolNames(ctx()).has("checkAgents")).toBe(true);
  });

  test("shown when the turn started with one open", () => {
    expect(
      chatbotHiddenToolNames(ctx({ backgroundAgents: true })).has(
        "checkAgents",
      ),
    ).toBe(false);
  });

  test("shown once this turn launched one", () => {
    const manager = new DynamicToolManager();
    manager.activate(["checkAgents"]);
    expect(
      chatbotHiddenToolNames(ctx({ dynamicToolManager: manager })).has(
        "checkAgents",
      ),
    ).toBe(false);
  });

  test("the team's blocked tools stay hidden either way", () => {
    const hidden = chatbotHiddenToolNames(
      ctx({ backgroundAgents: true, toolPolicies: { webFetch: "blocked" } }),
    );
    expect(hidden.has("webFetch")).toBe(true);
  });
});
