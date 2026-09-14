import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { continuableResponseMessages } from "../../../src/agents/shared/resume-messages";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { createSubAgentExecute } from "../../../src/agents/shared/sub-agent";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * A retry is handed what the dead attempt established.
 *
 * Measured 2026-09-14: a page build probed its four data sources and read the
 * component APIs it needed, then the host cut the stream at 133 seconds. The
 * fallback restarted from the original briefing, re-learned none of it, and
 * spent ninety steps on a page that never loaded. Two rules come out of that
 * turn — resume rather than restart, and a cut is not a verdict on the model,
 * so the SAME one gets one resumed attempt first.
 */

const ctx = () =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  });

const options = () => ({ toolCallId: "call_1", messages: [], context: ctx() });

interface Attempt {
  finishReason: string;
  text?: string;
  responseMessages?: ModelMessage[];
}

/** Records the messages each agent was handed, in call order. */
const recorder = () => {
  const seen: { id: string; messages: ModelMessage[] }[] = [];
  const agent = (id: string, attempts: Attempt[]) => {
    let call = 0;
    return {
      version: "agent-v1" as const,
      id,
      tools: {},
      stream: () => {
        throw new Error("not used");
      },
      generate: async (args: { messages: ModelMessage[] }) => {
        seen.push({ id, messages: args.messages });
        const attempt = attempts[Math.min(call, attempts.length - 1)];
        call += 1;
        return {
          text: attempt?.text ?? "",
          finishReason: attempt?.finishReason ?? "stop",
          steps: [],
          responseMessages: attempt?.responseMessages ?? [],
        };
      },
    };
  };
  return { seen, agent };
};

const probe: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "let me look at the data first" },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "pageProbe",
        input: { datasets: ["orders"] },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "pageProbe",
        output: { type: "json", value: { rowCount: 492 } },
      },
    ],
  },
];

type FakeAgent = ReturnType<ReturnType<typeof recorder>["agent"]>;

const execute = (primary: FakeAgent, fallback?: FakeAgent) =>
  createSubAgentExecute<never, {}, { task: string }, string>({
    subAgent: () => primary as never,
    ...(fallback ? { fallbackSubAgent: () => fallback as never } : {}),
    buildMessages: ({ task }) => [{ role: "user", content: task }],
    buildCallOptions: () => undefined as never,
    formatResult: (result) => result.text,
    deadlineMs: 60_000,
    onDeadline: () => "deadline",
  });

describe("continuableResponseMessages", () => {
  test("carries the tool call and its answer, drops the reasoning", () => {
    const carried = continuableResponseMessages(probe);
    expect(carried).toHaveLength(2);
    const parts = carried[0]?.content;
    expect(Array.isArray(parts) && parts.map((p) => p.type)).toEqual([
      "tool-call",
    ]);
    expect(carried[1]?.role).toBe("tool");
  });

  test("drops the provider envelope the first host was spoken to in", () => {
    const carried = continuableResponseMessages([
      {
        role: "assistant",
        providerOptions: { openrouter: { signature: "abc" } },
        content: [
          {
            type: "text",
            text: "done",
            providerOptions: { openrouter: { signature: "abc" } },
          },
        ],
      },
    ]);
    expect(carried[0]).not.toHaveProperty("providerOptions");
    const parts = carried[0]?.content;
    expect(Array.isArray(parts) && parts[0]).not.toHaveProperty(
      "providerOptions",
    );
  });

  test("drops a tool call nothing answered — it would wedge the retry", () => {
    expect(
      continuableResponseMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "orphan",
              toolName: "pageWrite",
              input: {},
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  test("drops a message left empty once its reasoning is gone", () => {
    expect(
      continuableResponseMessages([
        { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] },
      ]),
    ).toEqual([]);
  });

  test("an absent history is the empty list, not a throw", () => {
    expect(continuableResponseMessages(undefined)).toEqual([]);
    expect(continuableResponseMessages([])).toEqual([]);
  });
});

describe("a cut run resumes", () => {
  test("the SAME model gets one resumed attempt before the fallback", async () => {
    const { seen, agent } = recorder();
    const primary = agent("primary", [
      { finishReason: "other", responseMessages: probe },
      { finishReason: "stop", text: "built" },
    ]);
    const fallback = agent("fallback", [{ finishReason: "stop", text: "no" }]);
    const result = await execute(primary, fallback)(
      { task: "build the page" },
      options(),
    );

    expect(result).toBe("built");
    expect(seen.map((call) => call.id)).toEqual(["primary", "primary"]);
    // Second attempt: the briefing, then what the first attempt established.
    expect(seen[1]?.messages).toHaveLength(3);
    expect(seen[1]?.messages[0]?.role).toBe("user");
    expect(seen[1]?.messages[2]?.role).toBe("tool");
  });

  test("the fallback inherits both attempts' history", async () => {
    const { seen, agent } = recorder();
    const primary = agent("primary", [
      { finishReason: "other", responseMessages: probe },
      { finishReason: "other", responseMessages: [] },
    ]);
    const fallback = agent("fallback", [
      { finishReason: "stop", text: "recovered" },
    ]);
    const result = await execute(primary, fallback)(
      { task: "build the page" },
      options(),
    );

    expect(result).toBe("recovered");
    expect(seen.map((call) => call.id)).toEqual([
      "primary",
      "primary",
      "fallback",
    ]);
    expect(seen[2]?.messages).toHaveLength(3);
  });

  test("a budget exhaustion is not a cut — it goes straight to the fallback", async () => {
    // `length` would reproduce exactly on the same model; only a finish
    // nobody chose earns a same-model retry.
    const { seen, agent } = recorder();
    const primary = agent("primary", [{ finishReason: "length" }]);
    const fallback = agent("fallback", [
      { finishReason: "stop", text: "recovered" },
    ]);
    await execute(primary, fallback)({ task: "build" }, options());
    expect(seen.map((call) => call.id)).toEqual(["primary", "fallback"]);
  });

  test("a run that produced nothing to carry starts the fallback clean", async () => {
    const { seen, agent } = recorder();
    const primary = agent("primary", [{ finishReason: "other" }]);
    const fallback = agent("fallback", [
      { finishReason: "stop", text: "recovered" },
    ]);
    await execute(primary, fallback)({ task: "build" }, options());
    expect(seen.at(-1)?.messages).toHaveLength(1);
  });
});
