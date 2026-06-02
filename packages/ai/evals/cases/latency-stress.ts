/**
 * Latency-stress baselines. No `judge` assertions — these cases exist
 * purely to surface per-category latency so you can compare runs.
 * Each case gates on a `latencyUnder` value that's a rough ceiling
 * for its category on the current stack (MiniMax M2.7 primary +
 * DeepSeek V3.2 judge + OpenRouter routing + the team-scoped RAG
 * pipeline). Bump these when the stack gets faster or the team data
 * grows.
 *
 * Interpret failures as "this category got slower", not as bugs.
 * Langfuse records turn / model / tool latency on each trace — drill
 * into the dataset run to tell whether the slip comes from the model,
 * the tool, or both.
 */

import type { EvalSuite } from "../types";

export const latencyStressSuite: EvalSuite = {
  name: "latency-stress",
  summary:
    "Per-category latency baselines. No judge calls — pure wall-clock gates; turn/model/tool latency is recorded per trace in Langfuse.",
  cases: [
    {
      id: "lat-sql-simple",
      description: "Simple SQL count — should finish under 15s",
      prompt: "Combien ai-je de documents ?",
      tags: ["latency", "sql"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql"] },
        { type: "latencyUnder", ms: 30_000 },
      ],
    },
  ],
};
