import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  mergeUsage,
  readAgentUsage,
  readTurnUsage,
  recordStepUsage,
  resetTurnUsage,
  summarizeRunUsage,
  summarizeStep,
  turnRootOf,
} from "../../../src/lib/turn-usage";

/**
 * The first-party answer to "what did this turn spend".
 *
 * It exists because the only previous answer came from summing a trace's
 * observations in Langfuse, and on 2026-09-05 that sum was 22x the truth with
 * nothing downstream able to tell (`lib/langfuse-registration.ts`). Every
 * assertion here is about a number a decision gets made on, so each one is
 * written to fail if the arithmetic drifts — not merely if the shape does.
 */

const usageOf = (fields: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}): LanguageModelUsage => ({
  inputTokens: fields.input,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: fields.cacheRead,
    cacheWriteTokens: fields.cacheWrite,
  },
  outputTokens: fields.output,
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: fields.reasoning,
  },
  totalTokens: (fields.input ?? 0) + (fields.output ?? 0),
});

/** What OpenRouter puts on a call when `usage: { include: true }` is set. */
const billed = (costUsd: number): ProviderMetadata => ({
  openrouter: { usage: { cost: costUsd }, provider: "google-vertex" },
});

beforeEach(() => {
  resetTurnUsage();
});

describe("summarizeStep", () => {
  test("carries the billed cost and every token class", () => {
    const step = summarizeStep({
      usage: usageOf({
        input: 82_600,
        cacheRead: 70_700,
        cacheWrite: 1_200,
        output: 2_300,
        reasoning: 900,
      }),
      providerMetadata: billed(0.023),
    });

    expect(step.steps).toBe(1);
    expect(step.inputTokens).toBe(82_600);
    expect(step.cacheReadTokens).toBe(70_700);
    expect(step.cacheWriteTokens).toBe(1_200);
    expect(step.outputTokens).toBe(2_300);
    expect(step.reasoningTokens).toBe(900);
    expect(step.costUsd).toBe(0.023);
    expect(step.costedSteps).toBe(1);
  });

  test("a step with no usage at all is still a step", () => {
    // The SDK types `usage` as present and a double may not supply it. A
    // counter that threw here would fail the turn over a number nobody asked
    // for — and the step did happen, so `steps` has to say so.
    const step = summarizeStep({});

    expect(step.steps).toBe(1);
    expect(step.inputTokens).toBe(0);
    expect(step.costedSteps).toBe(0);
  });

  test("a step nobody priced counts as a step and not as money", () => {
    // A transport that publishes no cost must not read as a free call: the
    // step is real, `costUsd` is a floor, and `costedSteps` is what says so.
    const step = summarizeStep({
      usage: usageOf({ input: 1_000, output: 50 }),
      providerMetadata: undefined,
    });

    expect(step.steps).toBe(1);
    expect(step.inputTokens).toBe(1_000);
    expect(step.costUsd).toBe(0);
    expect(step.costedSteps).toBe(0);
  });
});

describe("summarizeRunUsage", () => {
  test("sums a run's steps, including the ones with no price", () => {
    const run = summarizeRunUsage([
      {
        usage: usageOf({ input: 1_000, output: 100, reasoning: 40 }),
        providerMetadata: billed(0.01),
      },
      {
        usage: usageOf({ input: 2_000, output: 200, reasoning: 60 }),
        providerMetadata: billed(0.02),
      },
      { usage: usageOf({ input: 500, output: 10 }) },
    ]);

    expect(run.steps).toBe(3);
    expect(run.costedSteps).toBe(2);
    expect(run.inputTokens).toBe(3_500);
    expect(run.outputTokens).toBe(310);
    expect(run.reasoningTokens).toBe(100);
    expect(run.costUsd).toBeCloseTo(0.03, 10);
  });

  test("an empty run is zero, not undefined", () => {
    expect(summarizeRunUsage([]).steps).toBe(0);
    expect(summarizeRunUsage([]).costUsd).toBe(0);
  });
});

describe("turnRootOf", () => {
  test("a delegate's trace folds onto the turn that dispatched it", () => {
    expect(turnRootOf("trace-1.page")).toBe("trace-1");
    expect(turnRootOf("trace-1.sub")).toBe("trace-1");
    expect(turnRootOf("trace-1")).toBe("trace-1");
  });
});

describe("recordStepUsage", () => {
  test("a turn's agents are separate buckets and one total", () => {
    const step = { usage: usageOf({ input: 100, output: 10 }) };
    recordStepUsage("turn-1", "chatbot", summarizeStep(step));
    recordStepUsage("turn-1.page", "chatbot.page-builder", summarizeStep(step));
    recordStepUsage("turn-1.page", "chatbot.page-builder", summarizeStep(step));

    const usage = readTurnUsage("turn-1");
    expect(usage?.total.steps).toBe(3);
    expect(usage?.byAgent["chatbot"]?.steps).toBe(1);
    expect(usage?.byAgent["chatbot.page-builder"]?.steps).toBe(2);
    // The whole point of the split: "what did the page cost" is one bucket,
    // and asking it through the delegate's own trace id must find it.
    expect(
      readAgentUsage("turn-1.page", "chatbot.page-builder")?.inputTokens,
    ).toBe(200);
  });

  test("two turns never share a ledger", () => {
    recordStepUsage(
      "turn-1",
      "chatbot",
      summarizeStep({
        usage: usageOf({ input: 100 }),
        providerMetadata: billed(0.5),
      }),
    );
    recordStepUsage(
      "turn-2",
      "chatbot",
      summarizeStep({
        usage: usageOf({ input: 100 }),
        providerMetadata: billed(0.25),
      }),
    );

    expect(readTurnUsage("turn-1")?.total.costUsd).toBe(0.5);
    expect(readTurnUsage("turn-2")?.total.costUsd).toBe(0.25);
  });

  test("a step with no trace id is dropped rather than pooled", () => {
    // Pooling anonymous steps under one key would quietly bill them to
    // whatever turn read next.
    recordStepUsage(
      undefined,
      "chatbot",
      summarizeStep({ usage: usageOf({}) }),
    );
    expect(readTurnUsage(undefined)).toBeUndefined();
  });

  test("a turn nobody recorded reads as undefined, never as zero", () => {
    // Zero would be indistinguishable from a free turn, and the eval decides
    // whether to fall back to Langfuse on exactly this difference.
    expect(readTurnUsage("never-seen")).toBeUndefined();
  });

  /**
   * The trap this ledger shipped in on 2026-09-06, and the reason the read
   * side is worth a test of its own.
   *
   * Two identifiers in this codebase are called a trace id. The ledger's is
   * the runtime context's — a UUIDv7 (the resumable `streamId`), suffixed by
   * every delegate. The other is Langfuse's span context, 32 hex characters,
   * and `handlers/chatbot.ts` had `readTurnUsage(getActiveTraceId())`: every
   * step was counted and not one was ever read back. Nothing failed. The
   * metadata simply omitted the spend, and the eval runner reported the cost
   * from Langfuse — the pipeline this ledger exists to stop trusting.
   */
  /**
   * A prompt cache belongs to the host that holds it. Steps summed across two
   * hosts hide the only thing that explains a full-price replay ten seconds
   * after a cached one, so the hosts are kept apart.
   */
  test("steps are split by the host that served them", () => {
    const step = (host: string, input: number, cached: number) => ({
      ...summarizeStep({}),
      inputTokens: input,
      cacheReadTokens: cached,
      providers: {
        [host]: { steps: 1, inputTokens: input, cacheReadTokens: cached },
      },
    });
    recordStepUsage("turn-7", "chatbot.page-builder", step("vertex", 100, 90));
    recordStepUsage("turn-7", "chatbot.page-builder", step("vertex", 100, 95));
    recordStepUsage("turn-7", "chatbot.page-builder", step("studio", 100, 0));

    const bucket = readAgentUsage("turn-7", "chatbot.page-builder");
    expect(bucket?.providers["vertex"]).toEqual({
      steps: 2,
      inputTokens: 200,
      cacheReadTokens: 185,
    });
    // The one that explains the bill: three steps, and a third of the input
    // paid at full rate on a host that had never seen the prefix.
    expect(bucket?.providers["studio"]).toEqual({
      steps: 1,
      inputTokens: 100,
      cacheReadTokens: 0,
    });
    expect(bucket?.steps).toBe(3);
  });

  test("merging two ledgers adds hosts rather than replacing them", () => {
    const a = {
      ...summarizeStep({}),
      providers: { vertex: { steps: 1, inputTokens: 10, cacheReadTokens: 9 } },
    };
    const b = {
      ...summarizeStep({}),
      providers: { studio: { steps: 1, inputTokens: 10, cacheReadTokens: 0 } },
    };
    const merged = mergeUsage(a, b);
    expect(Object.keys(merged.providers).sort()).toEqual(["studio", "vertex"]);
    // Neither input was mutated by the merge.
    expect(Object.keys(a.providers)).toEqual(["vertex"]);
  });

  test("a Langfuse trace id does not read a ledger keyed by the turn", () => {
    const runtimeTraceId = "0198f2c1-6a3e-7b21-9c44-7f0a2b6d1e58";
    const langfuseTraceId = "529b38becf7e5431c0d9cd2c88e0226f";
    recordStepUsage(
      runtimeTraceId,
      "chatbot",
      summarizeStep({
        usage: usageOf({ input: 100 }),
        providerMetadata: billed(0.5),
      }),
    );

    expect(readTurnUsage(runtimeTraceId)?.total.costUsd).toBe(0.5);
    // No hyphens to split on, so the fold to a turn root cannot rescue it.
    expect(readTurnUsage(langfuseTraceId)).toBeUndefined();
  });
});
