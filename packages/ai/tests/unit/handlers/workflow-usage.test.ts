import type { LanguageModelUsage } from "ai";
import { describe, expect, test } from "bun:test";
import { addDelegatedUsage, addUsage } from "../../../src/handlers/workflow";

/**
 * The turn that blew the budget was the one turn missing from the total.
 *
 * `turnUsage = await result.usage` is never reached on an abort, so the run of
 * 2026-09-17 failed with "Run exceeded its token budget (5589501 > 6000000)" —
 * a sentence that refutes itself — while the ~530 000 tokens of the aborted
 * turn went unbilled. The mid-turn accumulator that DID trip the abort was
 * sitting in the same scope, unused.
 */

const RUN_SO_FAR = {
  inputTokens: 5_478_807,
  outputTokens: 110_694,
  totalTokens: 5_589_501,
  cachedInputTokens: 5_182_000,
  turns: 1,
};

const usage = (total: number): LanguageModelUsage =>
  ({
    inputTokens: total - 10_000,
    outputTokens: 10_000,
    totalTokens: total,
    inputTokenDetails: { cacheReadTokens: 1_000 },
  }) as unknown as LanguageModelUsage;

describe("addUsage", () => {
  test("an aborted turn still bills what it spent", () => {
    const next = addUsage(RUN_SO_FAR, undefined, 2, 530_000);
    expect(next.totalTokens).toBe(6_119_501);
    // …and the budget message it prints is now true.
    expect(next.totalTokens).toBeGreaterThan(6_000_000);
  });

  test("the old behaviour was to add nothing, and to contradict itself", () => {
    const withoutFloor = addUsage(RUN_SO_FAR, undefined, 2);
    expect(withoutFloor.totalTokens).toBe(RUN_SO_FAR.totalTokens);
    expect(withoutFloor.totalTokens).toBeLessThan(6_000_000);
  });

  test("the provider's own total wins over the accumulator", () => {
    // Per-step figures are a sum of what each step reported; `result.usage` is
    // what the provider says the turn cost. The floor may only raise.
    const next = addUsage(RUN_SO_FAR, usage(600_000), 2, 530_000);
    expect(next.totalTokens).toBe(RUN_SO_FAR.totalTokens + 600_000);
  });

  test("the accumulator raises a provider total that under-reports", () => {
    // MiniMax under-reports per-step usage; nothing says the reverse cannot
    // happen, and a floor is only a floor.
    const next = addUsage(RUN_SO_FAR, usage(400_000), 2, 530_000);
    expect(next.totalTokens).toBe(RUN_SO_FAR.totalTokens + 530_000);
  });

  test("input, output and cache still come from the provider alone", () => {
    // The floor is a TOTAL. Splitting it across input/output would invent a
    // breakdown, and the cache share is what makes the total readable.
    const next = addUsage(RUN_SO_FAR, undefined, 2, 530_000);
    expect(next.inputTokens).toBe(RUN_SO_FAR.inputTokens);
    expect(next.outputTokens).toBe(RUN_SO_FAR.outputTokens);
    expect(next.cachedInputTokens).toBe(RUN_SO_FAR.cachedInputTokens);
    expect(next.turns).toBe(2);
  });
});

describe("addDelegatedUsage", () => {
  test("a run's sub-agents are billed to the run", () => {
    // Before this, a run that delegated its research spent those tokens
    // outside `workflow_runs.usage` and outside its budget: the executor's
    // stream never sees what runs inside one of its tool calls.
    const next = addDelegatedUsage(RUN_SO_FAR, {
      inputTokens: 300_000,
      outputTokens: 20_000,
      totalTokens: 320_000,
      cachedInputTokens: 250_000,
    });
    expect(next.totalTokens).toBe(RUN_SO_FAR.totalTokens + 320_000);
    expect(next.inputTokens).toBe(RUN_SO_FAR.inputTokens + 300_000);
    expect(next.outputTokens).toBe(RUN_SO_FAR.outputTokens + 20_000);
    expect(next.cachedInputTokens).toBe(RUN_SO_FAR.cachedInputTokens + 250_000);
    expect(next.turns).toBe(RUN_SO_FAR.turns);
  });
});
