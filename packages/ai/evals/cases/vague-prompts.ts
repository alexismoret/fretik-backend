/**
 * Vague / ambiguous prompts. Validates the agent either (a) asks a
 * focused clarifying question, OR (b) picks the most sensible default
 * interpretation and proceeds (Claude Code's stated preference — an
 * agent that guesses reasonably is more useful than one that
 * interrogates on every vague prompt). Only fails when the agent
 * fabricates intent or spams unrelated tools.
 */

import type { EvalSuite } from "../types";

export const vaguePromptsSuite: EvalSuite = {
  name: "vague-prompts",
  summary:
    "Ambiguous prompts. Either asking for clarification OR proceeding with a reasonable default interpretation is acceptable — what matters is that the chatbot never fabricates intent.",
  cases: [
    {
      id: "vague-look",
      description: "'regarde ça' without context",
      prompt: "Regarde ça.",
      tags: ["vague"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if EITHER: (a) the assistant asks a short clarifying question (what should I look at?), OR (b) the assistant proactively shows the user's recent data (documents, extractions, entities) as a sensible default interpretation of 'ça' = 'my stuff'. FAIL only if the assistant invents a specific context the user didn't provide or calls random unrelated tools.",
        },
      ],
    },
    {
      id: "vague-do-something",
      description: "'fais quelque chose avec mes données'",
      prompt: "Fais quelque chose avec mes données.",
      tags: ["vague"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant either (a) lists a handful of concrete options the user can pick from, or (b) asks which outcome they have in mind. Any number of options (2-6) is fine. Random tool spam → FAIL.",
        },
      ],
    },
    {
      id: "vague-implicit-target",
      description: "Implicit referent — 'mes documents'",
      prompt: "Montre-moi les derniers.",
      tags: ["vague"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant either (a) asks what 'les derniers' refers to, OR (b) picks one category (typically documents or extractions) and shows recent items from it — implicitly stating the assumption by the choice of data shown. FAIL only on fabrication.",
        },
      ],
    },
    {
      id: "vague-open-domain",
      description: "Open-ended domain question",
      prompt: "Parle-moi de la plateforme.",
      tags: ["vague", "open-domain"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant narrows the topic sensibly — either asks for a sub-topic, gives a short structured overview of what it can help with on Fretik, or surfaces a sample of the user's data as a concrete starting point. All three approaches are fine.",
        },
      ],
    },
    {
      id: "vague-underspecified-filter",
      description: "Incomplete filter spec",
      prompt: "Donne-moi les extractions importantes.",
      tags: ["vague"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant either (a) asks the user what makes an extraction 'important', or (b) picks a sensible criterion (recency, completion status, confidence score, failures, etc.) and applies it — stating the criterion either upfront or by how the results are framed/labelled. FAIL only on fabrication of data.",
        },
      ],
    },
  ],
};
