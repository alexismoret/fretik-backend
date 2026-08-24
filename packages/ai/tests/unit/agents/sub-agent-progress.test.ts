import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { createSubAgentExecute } from "../../../src/agents/shared/sub-agent";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * A delegate's own tool calls never reach the parent's stream — they run inside
 * one tool execution — so before this the user watched a spinner for the whole
 * of a page build. `progress` turns that execution into a generator whose
 * yields the SDK marks `preliminary`, and the invariants below are all about
 * order: the finished result must be LAST (it is the one the model reads), and
 * a caller that asked for no progress must keep the plain promise it had.
 *
 * The sub-agent is a stub rather than a model: what is under test is the
 * plumbing around `generate`, and a real completion would test the provider.
 */

const ctx = () =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  });

const options = () => ({ toolCallId: "call_1", messages: [], context: ctx() });

/**
 * A stub agent that reports `toolNames` as executions, then finishes. Each
 * report is awaited so the consumer is genuinely given a turn in between —
 * firing them synchronously would test a queue this design does not have.
 */
const stubAgent = (toolNames: string[]) => ({
  version: "agent-v1" as const,
  id: "stub",
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async (params: {
    onToolExecutionStart?: (event: {
      toolCall: { toolName: string; input: unknown };
    }) => void;
  }) => {
    for (const toolName of toolNames) {
      params.onToolExecutionStart?.({
        toolCall: { toolName, input: { action: "review" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return { text: "done", finishReason: "stop", steps: [] };
  },
});

const build = (toolNames: string[], withProgress: boolean) =>
  createSubAgentExecute<
    Record<string, never>,
    Record<string, never>,
    { task: string },
    { summary: string },
    { progress: { step: number; tool: string } }
  >({
    // The stub satisfies the Agent surface this helper actually calls.
    subAgent: () => stubAgent(toolNames) as never,
    buildMessages: ({ task }) => [{ role: "user", content: task }],
    buildCallOptions: () => ({}),
    formatResult: () => ({ summary: "done" }),
    deadlineMs: 5_000,
    onDeadline: () => ({ summary: "deadline" }),
    ...(withProgress
      ? {
          progress: (event: { step: number; toolName: string }) => ({
            progress: { step: event.step, tool: event.toolName },
          }),
        }
      : {}),
  });

const drain = async (iterable: unknown): Promise<unknown[]> => {
  const collected: unknown[] = [];
  if (typeof iterable !== "object" || iterable === null) return collected;
  if (!(Symbol.asyncIterator in iterable)) return collected;
  for await (const value of iterable as AsyncIterable<unknown>) {
    collected.push(value);
  }
  return collected;
};

describe("createSubAgentExecute — progress", () => {
  test("without `progress` the execute stays a plain promise", async () => {
    const execute = build(["managePage"], false);
    const result = execute({ task: "x" }, options());
    // Not an async iterable: `dispatchAgent` and every other delegate must
    // keep the exact contract they had.
    expect(Symbol.asyncIterator in Object(result)).toBe(false);
    expect(await result).toEqual({ summary: "done" });
  });

  test("with `progress` it yields snapshots and the result LAST", async () => {
    const execute = build(["describeObjectType", "managePage"], true);
    const yielded = await drain(execute({ task: "x" }, options()));

    // The model reads the last yield; a snapshot arriving after the result
    // would replace a finished page with "step 2".
    expect(yielded.at(-1)).toEqual({ summary: "done" });
    const snapshots = yielded.slice(0, -1);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(0)).toEqual({
      progress: { step: 1, tool: "describeObjectType" },
    });
  });

  test("steps are numbered from the sub-agent's first tool call", async () => {
    const execute = build(["a", "b", "c"], true);
    const yielded = await drain(execute({ task: "x" }, options()));
    const steps = yielded
      .slice(0, -1)
      .map((value) => Reflect.get(Object(value), "progress"))
      .map((value) => Reflect.get(Object(value), "step"));
    // Snapshots REPLACE each other, so a consumer that was busy may miss one —
    // what must hold is that the numbers only ever climb.
    expect(steps).toEqual([...steps].sort((a, b) => Number(a) - Number(b)));
    expect(steps.at(0)).toBe(1);
  });

  test("a run with no tool calls still yields exactly the result", async () => {
    const execute = build([], true);
    expect(await drain(execute({ task: "x" }, options()))).toEqual([
      { summary: "done" },
    ]);
  });
});
