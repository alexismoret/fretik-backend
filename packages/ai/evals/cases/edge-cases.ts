/**
 * Edge cases. Probes failure modes that are hard to catch with unit
 * tests because they require the full agent loop:
 *   - very long prompt / near-context-limit
 *   - malformed SQL attempts (should be caught by sanitizer)
 *   - Python sandbox failures degrade cleanly
 *   - large tool outputs flow through persisted-output
 *   - conversation boundary: no DB, nothing to ground on
 */

import type { EvalSuite } from "../types";

export const edgeCasesSuite: EvalSuite = {
  name: "edge-cases",
  summary:
    "Defensive cases: malformed inputs, empty data, large outputs, sandbox failures.",
  cases: [
    {
      id: "edge-unicode-identifier",
      description:
        "Identifier with European diacritics + Greek letter — must handle gracefully",
      // Previous version used a truck emoji 🚚 which caused MiniMax M2.7
      // (via OpenRouter) to silently return an empty response with
      // finishReason="other" — looks like a content-filter / tokenizer
      // choke on the emoji. European diacritics + Greek letters appear
      // in real business identifiers and are provider-safe. Keeps the
      // unicode-robustness test intent.
      prompt: "Que sais-tu du dossier RÉF-DÉMO-2024-Ω ?",
      tags: ["edge", "unicode"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "produced a non-empty answer",
          fn: (result) =>
            result.text.trim().length > 0 ||
            "assistant produced empty output — likely provider/model silent fail",
        },
        {
          type: "judge",
          rubric:
            "PASS if the assistant acknowledges the identifier in its answer and either searches for it or reports it wasn't found. No crash, no leaked stack trace.",
        },
      ],
    },
  ],
};
