/**
 * Simple single-turn Q&A that should not require any tool call.
 * Validates the model can answer directly when a tool isn't needed —
 * the #1 failure mode in over-tool-happy agents.
 */

import type { EvalSuite } from "../types";

export const simpleQaSuite: EvalSuite = {
  name: "simple-qa",
  summary:
    "Single-turn questions the model should answer without calling any tool.",
  cases: [
    {
      id: "qa-greet",
      description: "Plain greeting — no tool call expected",
      prompt: "Bonjour, qui es-tu ?",
      tags: ["smoke", "no-tool"],
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: ["searchKnowledge", "querySql", "searchWeb"],
        },
        { type: "latencyUnder", ms: 60_000 },
        {
          type: "judge",
          rubric:
            "The assistant introduces itself as Fretik's transport/logistics assistant or equivalent, in French, without calling any tool.",
        },
      ],
    },
    {
      id: "qa-capabilities",
      description: "What can you do? — meta question, pure text",
      prompt: "Que peux-tu faire pour moi ?",
      tags: ["smoke", "no-tool"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: ["searchKnowledge", "querySql"] },
        {
          type: "judge",
          rubric:
            "The answer mentions at least two concrete capabilities (e.g. searching documents, querying data, summarising extractions, fetching web info).",
        },
      ],
    },
    {
      id: "qa-arithmetic",
      description: "Trivial arithmetic — no tool needed",
      prompt: "Combien font 12 + 30 ?",
      tags: ["no-tool"],
      assertions: [
        { type: "noError" },
        { type: "contains", value: "42" },
        { type: "toolNotUsed", tools: ["python", "querySql"] },
      ],
    },
    {
      id: "qa-clarify",
      description: "Answer must stay tightly focused on the question asked",
      prompt: "Quelle est la différence entre un BL et une CMR ?",
      tags: ["domain-knowledge", "no-tool"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The answer correctly distinguishes a Bill of Lading (maritime) from a CMR (road) and stays on-topic in French. No hallucinated regulations.",
        },
      ],
    },
    {
      id: "qa-generalist-offtopic",
      description:
        "Generalist off-topic request — chatbot may answer if no work consequence",
      prompt: "Écris-moi un poème court sur la lune.",
      tags: ["generalist", "no-tool"],
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: ["searchKnowledge", "querySql", "searchWeb"],
        },
        {
          type: "judge",
          rubric:
            "The assistant answers the off-topic request helpfully — either by producing a poem about the moon, or by doing so in a couple of verses plus a short offer to return to transport topics. It does NOT refuse the request; the chatbot is a generalist assistant for transport/logistics employees, free to help with any request the user explicitly asks for as long as work accuracy is not at stake.",
        },
      ],
    },
  ],
};
