/**
 * What an agent actually puts on the wire under `providerOptions.openrouter`.
 *
 * The two unit suites beside this one pin the pure pieces — the merge and the
 * key derivation — and neither can catch the failure that matters: a
 * `prepareCall` that forgets to call the merge at all, or that adds the sticky
 * key by spreading and takes the caller's plugins with it. `prepareCall`
 * REPLACES the call settings wholesale, so "adds a key" and "destroys the
 * neighbours" are one character apart and have no symptom — a turn just
 * quietly re-OCRs a PDF it was told to keep raw, or runs at the wrong
 * reasoning depth.
 *
 * So this drives a REAL agent set and reads the params the model was handed.
 * The middleware short-circuits `wrapGenerate` without calling through, so no
 * request leaves the process: a test that reaches a provider is not an
 * integration test, it is a bill.
 */
import type {
  LanguageModelV4Middleware,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildAgentSet,
  type AgentRuntimeContextBase,
} from "../../../src/agents/shared/agent-builder";
import {
  clearResolvedModelCache,
  resolveModel,
  type ResolvedModel,
} from "../../../src/lib/model-registry/resolve";
import { installBoundFleet } from "../../lib/live-fleet";

let captured: SharedV4ProviderOptions | undefined;

const captureMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: ({ params }) => {
    captured = params.providerOptions;
    return Promise.resolve({
      content: [{ type: "text" as const, text: "ok" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    });
  },
};

const capturing = (resolved: ResolvedModel): ResolvedModel => ({
  ...resolved,
  model: wrapLanguageModel({
    model: resolved.model,
    middleware: captureMiddleware,
  }),
});

const CALL_OPTIONS = z.object({
  organizationId: z.string(),
  teamId: z.string(),
  conversationId: z.string().optional(),
  traceId: z.string().optional(),
});
type CallOptions = z.infer<typeof CALL_OPTIONS>;

const makeAgent = (sessionScope: "conversation" | "delegate") => {
  const resolved = capturing(resolveModel("chat"));
  return buildAgentSet<CallOptions, Record<string, never>>({
    id: `session-test-${sessionScope}`,
    sessionScope,
    buildTools: () => ({}),
    systemPrompt: () => "instructions",
    model: resolved,
    fallbackModel: resolved,
    callOptionsSchema: CALL_OPTIONS,
    buildRuntimeContextBase: (options): AgentRuntimeContextBase => ({
      organizationId: options.organizationId,
      teamId: options.teamId,
      ...(options.conversationId === undefined
        ? {}
        : { conversationId: options.conversationId }),
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    }),
  });
};

const run = async (
  sessionScope: "conversation" | "delegate",
  options: CallOptions,
  providerOptions?: SharedV4ProviderOptions,
): Promise<SharedV4ProviderOptions | undefined> => {
  captured = undefined;
  await makeAgent(sessionScope).primary.generate({
    prompt: "hello",
    options,
    ...(providerOptions === undefined ? {} : { providerOptions }),
  });
  return captured;
};

beforeAll(() => {
  installBoundFleet();
  clearResolvedModelCache();
});
beforeEach(() => {
  captured = undefined;
});

const BASE: CallOptions = {
  organizationId: "org-1",
  teamId: "team-1",
  conversationId: "conv-1",
  traceId: "stream-1",
};

describe("what an agent sends under providerOptions.openrouter", () => {
  test("a conversation agent sends the conversation as the sticky key", async () => {
    const sent = await run("conversation", BASE);
    expect(sent?.["openrouter"]?.["session_id"]).toBe("conv-1");
  });

  test("the key is stable across turns of one conversation", async () => {
    // The whole point: turn 2 must reuse turn 1's lane. Keyed on the trace id
    // — the per-turn stream id — this would change and the pin would never
    // take hold, which is the state this work replaces.
    const first = await run("conversation", { ...BASE, traceId: "stream-1" });
    const second = await run("conversation", { ...BASE, traceId: "stream-2" });
    expect(first?.["openrouter"]?.["session_id"]).toBe(
      second?.["openrouter"]?.["session_id"],
    );
  });

  test("a delegate does NOT inherit the parent's conversation lane", async () => {
    // A delegate resolves the same model as its parent, so a shared key puts
    // both on one pin — and a provider error inside the delegate would re-pin
    // the parent onto a host its prefix is cold on.
    const sent = await run("delegate", { ...BASE, traceId: "stream-1.sub" });
    expect(sent?.["openrouter"]?.["session_id"]).toBe("stream-1.sub");
    expect(sent?.["openrouter"]?.["session_id"]).not.toBe("conv-1");
  });

  test("the caller's own provider options survive the injection", async () => {
    // THE regression test. The handler sends `plugins` for a native PDF; the
    // agent adds the sticky key underneath. A spread instead of a merge would
    // leave `plugins` undefined here and nothing else would notice.
    const sent = await run("conversation", BASE, {
      openrouter: { plugins: [{ id: "file-parser" }] },
    });
    expect(sent?.["openrouter"]?.["plugins"]).toEqual([{ id: "file-parser" }]);
    expect(sent?.["openrouter"]?.["session_id"]).toBe("conv-1");
  });

  test("a namespace the agent does not touch is passed through", async () => {
    const sent = await run("conversation", BASE, {
      gateway: { only: ["groq"] },
    });
    expect(sent?.["gateway"]).toEqual({ only: ["groq"] });
    expect(sent?.["openrouter"]?.["session_id"]).toBe("conv-1");
  });

  test("nothing is sent when no stable id is in scope", async () => {
    // A caller with no conversation must not get a key invented for it — an
    // unstable key is worse than none, because OpenRouter's own hash of the
    // opening messages is at least stable when the messages are.
    const sent = await run("conversation", {
      organizationId: "org-1",
      teamId: "team-1",
    });
    expect(sent?.["openrouter"]?.["session_id"]).toBeUndefined();
  });
});
