/**
 * Latency-stress baselines. No `judge` assertions — these cases exist
 * purely to surface per-category latency so you can compare runs.
 * Each case gates on a `latencyUnder` value that's a rough ceiling
 * for its category on the current stack (MiniMax M2.7 primary +
 * DeepSeek V3.2 judge + OpenRouter routing + the team-scoped RAG
 * pipeline). Bump these when the stack gets faster or the team data
 * grows.
 *
 * Interpret failures as "this category got slower", not as bugs. The
 * reporter surfaces turn/model/tool latency per case plus the
 * per-tool p50/p95 breakdown — read that to tell whether the slip
 * comes from the model, the tool, or both.
 */

import type { EvalSuite } from "../types";

export const latencyStressSuite: EvalSuite = {
  name: "latency-stress",
  summary:
    "Per-category latency baselines. No judge calls — pure wall-clock gates with the reporter's turn/model/tool breakdown surfacing where time is spent.",
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
    {
      id: "lat-rag-content",
      description:
        "Content-grounded RAG turn — MiniMax reasoning dominates, ~30-120s",
      prompt: "Quel est le dernier document que tu as indexé ?",
      tags: ["latency", "rag"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["searchKnowledge", "querySql", "listDocuments"],
          mode: "any",
        },
        { type: "latencyUnder", ms: 150_000 },
      ],
    },
    {
      id: "lat-multi-tool",
      description:
        "Multi-tool turn — count + recent list combined, 5+ tool calls expected",
      prompt:
        "Donne-moi un aperçu rapide: combien de documents, combien d'extractions, et la plus récente de chaque.",
      tags: ["latency", "multi-tool"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["querySql", "listDocuments", "listExtractions"],
          mode: "any",
        },
        { type: "latencyUnder", ms: 120_000 },
      ],
    },
    {
      id: "lat-no-tool",
      description:
        "Pure conversation turn — no tool call, model reasoning only (MiniMax can still take 30-60s)",
      prompt:
        "Explique-moi en deux phrases ce qu'est un connaissement maritime.",
      tags: ["latency", "no-tool"],
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: ["searchKnowledge", "querySql", "searchWeb"],
        },
        { type: "latencyUnder", ms: 90_000 },
      ],
    },
  ],
};
