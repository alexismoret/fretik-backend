/**
 * Multi-step requests. We care about the end result, not the tool-call
 * shape: if the agent delivers a correct end-to-end answer with a single
 * tool, shortcutting a checklist is the right call.
 *
 * Curated case: `multi-no-overkill` guards the negative — a single-step
 * question must NOT over-trigger `manageTasks`.
 */

import type { EvalSuite } from "../types";

export const multiStepSuite: EvalSuite = {
  name: "multi-step",
  summary:
    "Complex requests spanning multiple sub-goals. Shortcutting via a single tool is allowed as long as every sub-goal is answered correctly.",
  cases: [
    {
      id: "multi-no-overkill",
      description: "Single-step question should NOT trigger manageTasks",
      prompt: "Combien ai-je de documents PDF ?",
      tags: ["multi-step", "negative"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: ["manageTasks"] },
        { type: "toolUsed", tools: ["querySql", "listDocuments"] },
      ],
    },
  ],
};
