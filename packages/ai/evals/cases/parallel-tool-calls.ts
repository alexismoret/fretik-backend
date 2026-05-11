/**
 * Parallel tool-call eval suite.
 *
 * Validates that the chatbot dispatches independent tool calls in the
 * same step rather than chaining them sequentially. The system-prompt
 * `<agent_philosophy>` section explicitly instructs the model to do
 * this; this suite makes the behaviour observable.
 *
 * **Known capability gap as of 2026-05-07:** MiniMax M2.7 on
 * OpenRouter does not actually emit parallel tool calls regardless of
 * the system-prompt instruction. We tested forcing
 * `parallelToolCalls: true` at the SDK level and the combo with
 * `require_parameters: true` empties the eligible provider pool (200
 * OK with empty body — see `lib/openrouter.ts`). Treat this suite as
 * a **model-capability canary**: a sustained pass means we have
 * (re-)gained native parallel dispatch — the prompt block alone is
 * inert without it.
 *
 * Detection method: walk the recorded `ToolCallTrace[]` in start-time
 * order and look for overlapping execution windows. Two tools whose
 * `[startedAtMs, startedAtMs + latencyMs]` intervals intersect ran in
 * parallel by definition. We tolerate a small `OVERLAP_TOLERANCE_MS`
 * to absorb timer/sse-frame jitter (a strict equality check would
 * false-fail when two `tool-input-available` frames arrive 1 ms apart
 * but render as a `<` in the comparison).
 *
 * The prompt is intentionally domain-agnostic — we rely on three
 * independent `querySql` lookups against the team schema. Each query
 * is a one-line aggregation that takes <100 ms, so genuine sequential
 * execution finishes well under the wall-clock window where
 * parallelism would overlap.
 */

import type { EvalSuite, InvokeResult } from "../types";

/**
 * Two execution windows are considered overlapping when one starts
 * strictly before the other finishes. The tolerance absorbs sub-frame
 * timer jitter on the SSE side.
 */
const OVERLAP_TOLERANCE_MS = 5;

const detectParallelToolCalls = (
  result: InvokeResult,
  required: number,
): true | string => {
  const calls = result.toolCalls
    .filter(
      (c): c is typeof c & { startedAtMs: number; latencyMs: number } =>
        typeof c.startedAtMs === "number" && typeof c.latencyMs === "number",
    )
    .slice()
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  if (calls.length < required) {
    return `expected at least ${String(required)} tool calls, got ${String(calls.length)}`;
  }

  let parallelCount = 1;
  let bestParallelCount = 1;
  let activeWindowEnd = calls[0]
    ? calls[0].startedAtMs + calls[0].latencyMs
    : 0;
  for (let i = 1; i < calls.length; i++) {
    const c = calls[i];
    if (!c) continue;
    if (c.startedAtMs + OVERLAP_TOLERANCE_MS < activeWindowEnd) {
      parallelCount++;
      activeWindowEnd = Math.max(activeWindowEnd, c.startedAtMs + c.latencyMs);
      if (parallelCount > bestParallelCount) bestParallelCount = parallelCount;
    } else {
      parallelCount = 1;
      activeWindowEnd = c.startedAtMs + c.latencyMs;
    }
  }

  if (bestParallelCount < required) {
    const trace = calls
      .map(
        (c) =>
          `${c.name}(start=${String(c.startedAtMs)},end=${String(c.startedAtMs + c.latencyMs)})`,
      )
      .join(" | ");
    return `max parallel tool calls observed = ${String(bestParallelCount)}, expected ≥ ${String(required)}. Trace: ${trace}`;
  }
  return true;
};

export const parallelToolCallsSuite: EvalSuite = {
  name: "parallel-tool-calls",
  summary:
    "Independent tool calls must run in the same step (overlapping execution windows), not chained sequentially.",
  cases: [
    {
      id: "parallel-three-counts",
      description:
        "Three independent COUNT queries — must dispatch in one step, not sequentially.",
      prompt:
        "Donne-moi en parallèle trois chiffres indépendants : (1) le nombre total de documents, (2) le nombre total d'entités, (3) le nombre total d'extractions, pour mon équipe. Ce sont trois lookups indépendants, exécute-les en parallèle.",
      tags: ["parallel-tool-calls", "performance"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql"], mode: "any" },
        {
          type: "custom",
          name: "at-least-2-parallel-querysql-calls",
          fn: (result) => detectParallelToolCalls(result, 2),
        },
      ],
    },
  ],
};
