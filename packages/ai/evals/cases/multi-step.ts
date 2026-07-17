/**
 * Multi-step requests. We care about the end result, not the tool-call
 * shape: if the agent delivers a correct end-to-end answer with a single
 * tool, shortcutting is the right call.
 *
 * Curated case: `multi-no-overkill` guards the negative — a single-step
 * question must go straight to the one right tool, no planning overhead.
 * It also carries the simple-lookup latency ceiling (absorbed from the
 * former single-case `latency-stress` suite): per-trace turn/model/tool
 * latency stays recorded in Langfuse for drill-down.
 */

import type { EvalSuite } from "../types";

export const multiStepSuite: EvalSuite = {
  name: "multi-step",
  summary:
    "Complex requests spanning multiple sub-goals. Shortcutting via a single tool is allowed as long as every sub-goal is answered correctly.",
  cases: [
    {
      id: "multi-no-overkill",
      description:
        "Single-step question goes straight to the one right tool — no planning overhead",
      prompt: "Combien ai-je de documents PDF ?",
      tags: ["multi-step", "negative"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql", "listDocuments"] },
        { type: "latencyUnder", ms: 30_000 },
      ],
    },
  ],
};
