import { describe, expect, test } from "bun:test";
import type { TrajectorySummary } from "../../src/services/trajectory/extract";
import { foldTurnWork } from "../../src/services/trajectory/run-work";

/**
 * A run is many turns, and `workflow_runs.usage` is cumulative — so the work
 * counters accumulate exactly the way the token counters already do.
 */

const summary = (over: Partial<TrajectorySummary> = {}): TrajectorySummary => ({
  totalCalls: 0,
  perTool: {},
  errorCalls: 0,
  perErrorCode: {},
  errorThenRetry: 0,
  redundantCalls: 0,
  skillReads: { calls: 0, distinctFiles: 0 },
  pythonCells: { count: 0, chars: 0, recoveredAfterError: 0 },
  recipeUsed: false,
  outputChars: 0,
  perTask: [],
  ...over,
});

describe("foldTurnWork", () => {
  test("the first turn starts from zero, not from nothing", () => {
    const work = foldTurnWork(undefined, {
      steps: 4,
      summary: summary({ totalCalls: 6, perTool: { python: 5, read: 1 } }),
    });
    expect(work.steps).toBe(4);
    expect(work.toolCalls).toBe(6);
    expect(work.perTool).toEqual({ python: 5, read: 1 });
    expect(work.recipeUsed).toBe(false);
  });

  test("the histogram merges across turns instead of replacing", () => {
    const first = foldTurnWork(undefined, {
      steps: 2,
      summary: summary({ totalCalls: 2, perTool: { read: 2 } }),
    });
    const second = foldTurnWork(first, {
      steps: 3,
      summary: summary({ totalCalls: 4, perTool: { read: 1, python: 3 } }),
    });
    expect(second.steps).toBe(5);
    expect(second.toolCalls).toBe(6);
    expect(second.perTool).toEqual({ read: 3, python: 3 });
  });

  test("a run that used its recipe once used it", () => {
    // Sticky on purpose: `recipeUsed` is the acceptance gate for a derived
    // recipe, and a later turn that had no reason to touch the file must not
    // erase the evidence that an earlier one did.
    const first = foldTurnWork(undefined, {
      steps: 1,
      summary: summary({ recipeUsed: true }),
    });
    const second = foldTurnWork(first, {
      steps: 1,
      summary: summary({ recipeUsed: false }),
    });
    expect(second.recipeUsed).toBe(true);
  });

  test("skill reads and errors accumulate from their own fields", () => {
    const work = foldTurnWork(undefined, {
      steps: 1,
      summary: summary({
        skillReads: { calls: 3, distinctFiles: 2 },
        errorCalls: 1,
        redundantCalls: 2,
        pythonCells: { count: 4, chars: 900, recoveredAfterError: 1 },
        outputChars: 12_000,
      }),
    });
    expect(work.skillReads).toBe(3);
    expect(work.errorCalls).toBe(1);
    expect(work.redundantCalls).toBe(2);
    expect(work.pythonCells).toBe(4);
    expect(work.outputChars).toBe(12_000);
  });
});
