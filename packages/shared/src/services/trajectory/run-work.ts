/**
 * Fold one turn's trajectory into the run's running totals.
 *
 * A run is many turns, and `workflow_runs.usage` is cumulative, so the work
 * counters accumulate the same way the token counters do. The turn's own
 * trajectory is the slice of messages the turn added — not the whole history,
 * which is windowed to 40 messages and would silently drop the early steps of
 * a long run, and not the whole conversation, which would cost a query a turn.
 */

import type { WorkflowRunWork } from "../../schemas/workflows";
import type { TrajectorySummary } from "./extract";

const EMPTY: WorkflowRunWork = {
  steps: 0,
  toolCalls: 0,
  perTool: {},
  skillReads: 0,
  errorCalls: 0,
  redundantCalls: 0,
  pythonCells: 0,
  outputChars: 0,
  recipeUsed: false,
};

const mergeCounts = (
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> => {
  const merged: Record<string, number> = { ...a };
  for (const [key, count] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
};

export const foldTurnWork = (
  previous: WorkflowRunWork | undefined,
  turn: { steps: number; summary: TrajectorySummary },
): WorkflowRunWork => {
  const base = previous ?? EMPTY;
  const { summary } = turn;
  return {
    steps: base.steps + turn.steps,
    toolCalls: base.toolCalls + summary.totalCalls,
    perTool: mergeCounts(base.perTool, summary.perTool),
    skillReads: base.skillReads + summary.skillReads.calls,
    errorCalls: base.errorCalls + summary.errorCalls,
    // Per-turn redundancy only. A run that reads the same file in two
    // different turns is doing something the windowed history made it do, and
    // charging that to the model would report the context limit as a defect of
    // the agent.
    redundantCalls: base.redundantCalls + summary.redundantCalls,
    pythonCells: base.pythonCells + summary.pythonCells.count,
    outputChars: base.outputChars + summary.outputChars,
    // Sticky: a run that reached for its recipe once used it, and a later turn
    // that did not touch it must not erase that.
    recipeUsed: base.recipeUsed || summary.recipeUsed,
  };
};
