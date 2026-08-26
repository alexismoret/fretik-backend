import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { createSubAgentExecute } from "../../../src/agents/shared/sub-agent";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * What happens between a dead run and the retry that would replace it.
 *
 * The ordering is the substance. A delegate cut mid-flight can be holding a
 * finished deliverable in its own transcript — `buildPage` streams page source
 * as text so that it does — and retrying from zero there throws away work that
 * was already paid for, then rolls the same dice again on the same upstream.
 * So: rescue first, retry only if there was nothing to rescue.
 */

const ctx = () =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  });

const options = () => ({ toolCallId: "call_1", messages: [], context: ctx() });

/** A run that died having only read — the retryable shape. */
const deadAgent = (id: string) => ({
  version: "agent-v1" as const,
  id,
  tools: {},
  stream: () => {
    throw new Error("not used");
  },
  generate: async () => ({
    text: "",
    finishReason: "length",
    steps: [{ toolCalls: [] }],
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

const run = async (salvaged: string | null) => {
  let fallbackUsed = false;
  const execute = createSubAgentExecute<
    never,
    {},
    { task: string },
    string,
    never,
    string
  >({
    subAgent: () => deadAgent("primary") as never,
    fallbackSubAgent: () => {
      fallbackUsed = true;
      return liveAgent("fallback") as never;
    },
    salvage: async () => salvaged,
    buildMessages: () => [],
    buildCallOptions: () => undefined as never,
    formatResult: (result, rescued) => rescued ?? result.text,
    onDeadline: () => "deadline",
    deadlineMs: 5_000,
  });
  // Awaited BEFORE the object literal reads the flag: a property list is
  // evaluated left to right, so `{ fallbackUsed, text: await … }` would
  // capture the flag from before the run.
  const text = await execute({ task: "t" }, options());
  return { fallbackUsed, text };
};

describe("sub-agent salvage", () => {
  test("a rescued deliverable cancels the retry", async () => {
    const { fallbackUsed, text } = await run("saved-page");
    expect(fallbackUsed).toBe(false);
    expect(text).toBe("saved-page");
  });

  test("nothing to rescue leaves the retry exactly as it was", async () => {
    const { fallbackUsed, text } = await run(null);
    expect(fallbackUsed).toBe(true);
    expect(text).toBe("recovered");
  });

  test("a caller with no salvage hook is untouched by any of this", async () => {
    let fallbackUsed = false;
    const execute = createSubAgentExecute<never, {}, { task: string }, string>({
      subAgent: () => deadAgent("primary") as never,
      fallbackSubAgent: () => {
        fallbackUsed = true;
        return liveAgent("fallback") as never;
      },
      buildMessages: () => [],
      buildCallOptions: () => undefined as never,
      formatResult: (result) => result.text,
      onDeadline: () => "deadline",
      deadlineMs: 5_000,
    });
    expect(await execute({ task: "t" }, options())).toBe("recovered");
    expect(fallbackUsed).toBe(true);
  });
});

describe("sub-agent fallback budget", () => {
  /**
   * The fallback used to share the primary's signal, so a first attempt that
   * spent the budget handed the second one a signal already aborting: a retry
   * born dead, billed in full, and indistinguishable in the trace from a
   * second model that failed. It gets a floor now.
   */
  test("the fallback runs even when the primary consumed the whole deadline", async () => {
    let fallbackSignal: AbortSignal | undefined;
    const slowPrimary = {
      version: "agent-v1" as const,
      id: "primary",
      tools: {},
      stream: () => {
        throw new Error("not used");
      },
      generate: async () => {
        await Bun.sleep(60);
        return { text: "", finishReason: "length", steps: [{ toolCalls: [] }] };
      },
    };
    const execute = createSubAgentExecute<never, {}, { task: string }, string>({
      subAgent: () => slowPrimary as never,
      fallbackSubAgent: () =>
        ({
          version: "agent-v1" as const,
          id: "fallback",
          tools: {},
          stream: () => {
            throw new Error("not used");
          },
          generate: async (args: { abortSignal?: AbortSignal }) => {
            fallbackSignal = args.abortSignal;
            return { text: "recovered", finishReason: "stop", steps: [] };
          },
        }) as never,
      buildMessages: () => [],
      buildCallOptions: () => undefined as never,
      formatResult: (result) => result.text,
      onDeadline: () => "deadline",
      // Already spent by the time the primary returns.
      deadlineMs: 50,
    });
    expect(await execute({ task: "t" }, options())).toBe("recovered");
    expect(fallbackSignal?.aborted).toBe(false);
  });
});
