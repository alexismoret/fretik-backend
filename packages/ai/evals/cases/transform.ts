/**
 * Transform cases — the doctrine the `transform` tool + its `<tool_routing>`
 * row target: a document-scale, length-preserving text transformation
 * (translate / rewrite / restyle) must route to `transform`, NOT be
 * authored by hand inside `python` string literals.
 *
 * This pins the failure that motivated the tool: a prod turn asked to
 * translate a 120K-char FAQ ran 24 python calls authoring the translation
 * as string literals, then died mid-stream. The signal is the tool
 * trajectory (transform used, python NOT used for the authoring), which is
 * deterministic — no judge needed.
 *
 * A counter-probe guards the other side: a trivial one-line translation
 * must NOT reach for `transform` (it belongs inline in the reply), so the
 * routing doesn't over-fire on small text.
 */

import type { EvalSuite } from "../types";

export const transformSuite: EvalSuite = {
  name: "transform",
  summary:
    "Document-scale prose transformation routes to `transform` (not python-authored literals); trivial text stays inline.",
  cases: [
    {
      id: "transform-translate-large-doc",
      description:
        "A whole-document translation routes to `transform` and is delivered as a file — never authored in python",
      prompt:
        "Traduis l'intégralité du document long-report.md en français, en conservant la structure markdown. Livre le résultat dans un fichier.",
      tags: ["transform", "tool-use", "generation"],
      fixtures: ["long-report.md"],
      budget: {
        maxToolCalls: 6,
        expectedTools: ["searchTools", "transform", "presentFiles"],
      },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["transform"] },
        // The core anti-pattern: the model must NOT author the translation
        // as python string literals.
        { type: "toolNotUsed", tools: ["python"] },
      ],
    },
    {
      id: "transform-not-for-trivial-text",
      description:
        "A one-line translation is answered inline — `transform` is not over-triggered on small text",
      prompt:
        "Traduis cette phrase en anglais, rien d'autre : « Le rapport trimestriel sera publié la semaine prochaine. »",
      tags: ["transform", "tool-use", "efficiency"],
      budget: { maxToolCalls: 1 },
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: ["transform"] },
        { type: "contains", value: "report" },
      ],
    },
  ],
};
