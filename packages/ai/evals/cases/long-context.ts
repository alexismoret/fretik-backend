/**
 * Long-context eval suite (C3 model gate) — long-document handling
 * discipline on synthetic + real fixtures, scored mechanically (the
 * fixtures' content is deterministic).
 *
 * Deliberately LEAN (2 cases, never smoke): session 8 reverted a
 * 36-page OCR case because it made full runs too long. TRUE
 * near-compaction-threshold cases (~180K tokens of history) are
 * deferred for the same reason — these probe long-document retrieval
 * precision, which is the failure mode that matters at this size.
 */

import type { EvalSuite } from "../types";

export const longContextSuite: EvalSuite = {
  name: "long-context",
  summary:
    "Long-document retrieval precision: exact deep-line retrieval in a 500-line report, cross-document facts in a multi-document merged PDF.",
  cases: [
    {
      id: "lc-deep-retrieval",
      description:
        "Exact retrieval deep in a 500-line file — no approximation, no hallucinated neighbours",
      prompt:
        "Dans le fichier joint long-report.md : quel est le numéro de note mentionné à la ligne 437 ? Réponds avec le numéro exact.",
      tags: ["long-context"],
      fixtures: ["long-report.md"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read", "bash", "python"], mode: "any" },
        { type: "contains", value: "437" },
      ],
    },
    {
      id: "lc-multidoc-qa",
      description:
        "Merged multi-document PDF — issuer + VAT number recovered across ~950 OCR lines",
      prompt:
        "Le PDF joint regroupe plusieurs documents fusionnés. Identifie la société émettrice principale et donne son numéro de TVA intracommunautaire exact.",
      tags: ["long-context"],
      fixtures: ["ilovepdf_merged.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read", "vision", "python"], mode: "any" },
        { type: "contains", value: "vivavin", caseInsensitive: true },
        { type: "regex", value: "432\\s*826\\s*832" },
      ],
    },
  ],
};
