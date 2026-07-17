/**
 * RAG precision cases. Validates that `searchKnowledge` is the tool
 * reached for for factual document-grounded questions, and that the
 * answer cites its source.
 *
 * These cases are deliberately generic — the ground truth depends on
 * the data present in the eval team (`EVAL_TEAM_ID`). Customise the
 * `contains`/`judge` assertions to your fixture dataset when tuning.
 * The shape is meant to be copy-pasted into team-specific variants.
 */

import type { EvalSuite } from "../types";

export const ragPrecisionSuite: EvalSuite = {
  name: "rag-precision",
  summary:
    "Factual questions that must ground their answer on team documents via searchKnowledge.",
  cases: [
    {
      id: "rag-specific-id",
      description: "Uncommon literal identifier triggers BM25 strength",
      prompt: "Que sais-tu sur le dossier CONTRAT-2024-0342 ?",
      tags: ["rag", "bm25-anchor"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "custom",
          name: "non-empty output (skip judge if the provider timed out)",
          fn: (result) =>
            result.text.trim().length > 0 ||
            "empty output — likely provider timeout on a long multi-search turn; re-run to confirm",
        },
        {
          type: "judge",
          rubric:
            "PASS if either: (a) the assistant cites a document whose content contains the LITERAL string 'CONTRAT-2024-0342' (exact substring), or (b) the tool outputs do NOT contain that literal string (only fuzzy/semantic matches with different identifiers) and the assistant states the identifier was not found. Fuzzy matches on tokens like 'CONTRAT' or '2024' alone do NOT count as finding the identifier. If the assistant text is empty due to a model timeout, PASS (the quality is untestable).",
        },
      ],
    },
    {
      id: "rag-no-match",
      description: "Obviously out-of-corpus question — must say so",
      prompt:
        "Que dit notre documentation au sujet de la livraison de colis sur Mars ?",
      tags: ["rag", "no-match"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant states that no document about Mars deliveries was found. Transparently explaining what the fuzzy search returned (e.g. 'I found a document about Maurice, which is phonetically close but unrelated') is NOT fabrication — it is honest reporting. FAIL only if the assistant invents content claiming the documentation covers Mars deliveries.",
        },
      ],
    },
  ],
};
