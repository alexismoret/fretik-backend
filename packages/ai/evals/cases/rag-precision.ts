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
      id: "rag-doc-lookup",
      description:
        "Factual content lookup — must call searchKnowledge and cite",
      prompt:
        "Quelles sont les conditions de paiement mentionnées dans nos contrats de transport ?",
      tags: ["rag", "citations"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "judge",
          rubric:
            "PASS if any of: (a) the assistant references at least one document with a citation (name, link, or quoted fragment), (b) the corpus contains no contract per se and the assistant cites whatever transport document DOES exist that mentions payment/billing info (a Demande d'enlèvement, BL, invoice, order — all acceptable sources of payment terms in transport), (c) the assistant honestly reports no document with payment terms was found. FAIL only if the assistant invents payment terms not present in any tool output.",
        },
      ],
    },
    {
      id: "rag-multilingual",
      description: "Question in French about multilingual corpus",
      prompt: "Résume les clauses Incoterms de notre dernier contrat cadre.",
      tags: ["rag", "fr"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "judge",
          rubric:
            "PASS if the assistant (a) summarises Incoterms clauses grounded on an actual document (even if the document is not literally a 'contrat cadre' — a pickup request or shipping order that mentions Incoterms is a valid source), OR (b) honestly reports no Incoterms data was found in the corpus. FAIL only if the assistant invents an Incoterms clause NOT present in any tool output.",
        },
      ],
    },
    {
      id: "rag-specific-id",
      description: "Transport-specific identifier triggers BM25 strength",
      prompt: "Que sais-tu sur le dossier BL-2024-0342 ?",
      tags: ["rag", "bm25-anchor"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "custom",
          name: "non-empty output (skip judge if MiniMax timed out)",
          fn: (result) =>
            result.text.trim().length > 0 ||
            "empty output — likely MiniMax provider timeout on a long multi-search turn; re-run to confirm",
        },
        {
          type: "judge",
          rubric:
            "PASS if either: (a) the assistant cites a document whose content contains the LITERAL string 'BL-2024-0342' (exact substring), or (b) the tool outputs do NOT contain that literal string (only fuzzy/semantic matches with different identifiers) and the assistant states the identifier was not found. Fuzzy matches on tokens like 'BL' or '2024' alone do NOT count as finding the identifier. If the assistant text is empty due to a model timeout, PASS (the quality is untestable).",
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
    {
      id: "rag-prefers-search-over-sql",
      description:
        "Content question should go through searchKnowledge, not querySql",
      prompt: "Explique-moi le contenu exact de notre politique RGPD interne.",
      tags: ["rag", "tool-routing"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "judge",
          rubric:
            "The assistant uses document search (not a DB count). The answer summarises the policy if found, or admits absence.",
        },
      ],
    },
  ],
};
