/**
 * CI gate: run the PR SMOKE experiment and fail on a correctness drop.
 *
 * PR tier = the SMOKE subset (~1 case/capability) WITH the judge — the
 * chatbot turn is the dominant per-case cost, so keeping the cheap judge
 * catches semantic regressions for negligible extra spend. The full suite
 * + judge + trials run nightly (`bun run evals:langfuse`).
 *
 * Regression check runs AFTER the experiment, comparing the run-level
 * `correctness` to a threshold (`RegressionError`, the validated pattern —
 * not inside an evaluator). Start conservative; track the frozen baseline.
 *
 * Run with Bun (`bun run evals/langfuse/gate.ts`) — our eval stack is
 * Bun-native + pulls the full @fretik graph, so the node-based
 * `langfuse/experiment-action` does NOT fit; `.github/workflows/langfuse-experiment.yml`
 * drives this with Bun. `experiment(context)` is kept for any future
 * action use. Needs a LIVE @fretik/ai service at `AI_SERVICE_URL`.
 * PR-blocking is a follow-up once that service runs reproducibly in CI.
 */

import { RegressionError, type RunnerContext } from "@langfuse/client";
import { runChatbotExperiment } from "./experiment";

const THRESHOLD = Number(process.env.EVAL_CORRECTNESS_THRESHOLD ?? "0.6");

const runGate = async () => {
  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  const result = await runChatbotExperiment({
    smoke: true,
    deterministicOnly: false,
    ...(sha ? { runName: `pr-${sha}` } : {}),
    metadata: { tier: "pr-smoke" },
  });
  const correctness = result.runEvaluations.find(
    (e) => e.name === "correctness",
  )?.value;
  if (typeof correctness !== "number" || correctness < THRESHOLD) {
    throw new RegressionError({
      result,
      metric: "correctness",
      value: typeof correctness === "number" ? correctness : 0,
      threshold: THRESHOLD,
    });
  }
  return result;
};

/** Kept for future `langfuse/experiment-action` use (node-based). */
export const experiment = async (_context: RunnerContext) => runGate();

if (import.meta.main) {
  runGate()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      if (err instanceof RegressionError) {
        console.error(`[gate] regression: ${err.message}`);
      } else {
        console.error("[gate] fatal:", err);
      }
      process.exit(1);
    });
}
