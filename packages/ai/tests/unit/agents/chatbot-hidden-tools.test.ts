import { describe, expect, test } from "bun:test";
import { chatbotHiddenToolNames } from "../../../src/agents/chatbot/hidden-tools";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * `manageAgents` is on the chat agent's list only once the conversation has a
 * sub-agent for it to manage. Two gates, both needed: a turn that STARTS in a
 * conversation with sub-agents (the handler reads that), and a turn that
 * LAUNCHES one (the dispatch activates the tool mid-turn).
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

describe("manageAgents gate", () => {
  test("hidden in a conversation with no sub-agent", () => {
    expect(chatbotHiddenToolNames(ctx()).has("manageAgents")).toBe(true);
  });

  test("shown when the conversation already has sub-agents", () => {
    expect(
      chatbotHiddenToolNames(ctx({ hasSubAgents: true })).has("manageAgents"),
    ).toBe(false);
  });

  test("shown once this turn launched one", () => {
    const manager = new DynamicToolManager();
    manager.activate(["manageAgents"]);
    expect(
      chatbotHiddenToolNames(ctx({ dynamicToolManager: manager })).has(
        "manageAgents",
      ),
    ).toBe(false);
  });

  test("the team's blocked tools stay hidden either way", () => {
    const hidden = chatbotHiddenToolNames(
      ctx({ hasSubAgents: true, toolPolicies: { webFetch: "blocked" } }),
    );
    expect(hidden.has("webFetch")).toBe(true);
  });
});
