import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { createSubAgentExecute } from "../../../src/agents/shared/sub-agent";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * When a dead delegate run may be retried.
 *
 * The rule is CHANGED nothing, not DID nothing. The page builder opens every
 * run by reading its environment guide, looking up a component API and probing
 * the data, so the old "no tool call at all" test never fired for it: measured
 * 2026-08-23, two of four eval cases lost a whole build to a run that died
 * before saving, and the parent's only remedy was calling `buildPage` again
 * from zero — the most expensive recovery in the product.
 *
 * What must stay true is the other half: a run that WROTE is never retried,
 * because a second attempt would write twice.
 */

const ctx = () =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  });

const options = () => ({ toolCallId: "call_1", messages: [], context: ctx() });

/** A run that died: no text, no clean finish, but these tool calls happened. */
const deadAgent = (
  calls: { toolName: string; input: unknown }[],
  id: string,
) => ({
  version: "agent-v1" as const,
  id,
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async () => ({
    text: "",
    finishReason: "length",
    steps: [{ toolCalls: calls }],
  }),
});

const liveAgent = (id: string) => ({
  version: "agent-v1" as const,
  id,
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async () => ({
    text: "recovered",
    finishReason: "stop",
    steps: [],
  }),
});

const pageBuilderSideEffect = ({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) => {
  if (toolName !== "managePage") return true;
  const action =
    typeof input === "object" && input !== null && "action" in input
      ? (input as { action?: unknown }).action
      : undefined;
  return !["get_guide", "components", "dry_run", "get", "list"].includes(
    String(action),
  );
};

const run = async (calls: { toolName: string; input: unknown }[]) => {
  let fallbackUsed = false;
  const execute = createSubAgentExecute<never, {}, { task: string }, string>({
    subAgent: () => deadAgent(calls, "primary") as never,
    fallbackSubAgent: () => {
      fallbackUsed = true;
      return liveAgent("fallback") as never;
    },
    hasSideEffect: pageBuilderSideEffect,
    buildMessages: () => [],
    buildCallOptions: () => undefined as never,
    formatResult: (result) => result.text,
    onDeadline: () => "deadline",
    deadlineMs: 5_000,
  });
  const text = await execute({ task: "t" }, options());
  return { fallbackUsed, text };
};

describe("sub-agent retry — reads do not block it", () => {
  test("a build that only read before dying is retried", async () => {
    const { fallbackUsed, text } = await run([
      { toolName: "managePage", input: { action: "get_guide" } },
      { toolName: "managePage", input: { action: "components" } },
      { toolName: "managePage", input: { action: "dry_run" } },
    ]);
    expect(fallbackUsed).toBe(true);
    expect(text).toBe("recovered");
  });

  test("a build that CREATED a page is never retried", async () => {
    const { fallbackUsed } = await run([
      { toolName: "managePage", input: { action: "get_guide" } },
      { toolName: "managePage", input: { action: "create" } },
    ]);
    expect(fallbackUsed).toBe(false);
  });

  test("`review` counts as a write — it stores a round of the page", async () => {
    const { fallbackUsed } = await run([
      { toolName: "managePage", input: { action: "review" } },
    ]);
    expect(fallbackUsed).toBe(false);
  });

  test("an unrecognised tool is treated as a write, not assumed safe", async () => {
    const { fallbackUsed } = await run([
      { toolName: "somethingElse", input: {} },
    ]);
    expect(fallbackUsed).toBe(false);
  });
});
