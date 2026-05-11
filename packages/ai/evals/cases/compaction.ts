/**
 * Compaction eval suite. Covers the compaction service end-to-end
 * after the Claude-Code-aligned rewrite:
 *   - Effective-window threshold pattern (`window − summary_max −
 *     13K buffer`), MiniMax M2.7 → ~163K tokens by default.
 *   - 9-section CC summariser prompt with `<analysis>...<summary>`
 *     envelope (see `services/compaction/prompt.ts`).
 *   - Microcompact pass that replaces older read-only tool-results
 *     (`searchKnowledge`, `read`, `listDocuments`, …) with a marker
 *     while keeping the last 5 verbatim.
 *   - Runtime-state attachments: cumulative `searchTools` activations
 *     are re-injected via a synthetic message so the post-compact
 *     turn sees the same domain tools active; the latest `manageTasks`
 *     pending list is mentioned in the summary text.
 *   - Default summariser model: `deepseek/deepseek-v4-flash` (1M
 *     context, env-overridable via `OPENROUTER_COMPACTION_MODEL`).
 *
 * Each case checks for preservation of load-bearing specifics (file
 * paths, tool call IDs, domain identifiers, runtime state) after the
 * summariser has fired.
 *
 * IMPORTANT — live-stack requirement. These cases need a long
 * conversation to actually exercise the compaction path (> 163K
 * tokens at default config). The harness creates a fresh conversation
 * per run, so short prompts won't cross the threshold on their own.
 * Operators can either:
 *   1. Seed a fixture conversation with a 170K+-token scrollback via
 *      the DB before running this suite, or
 *   2. Temporarily shrink `OPENROUTER_CHAT_MODEL_CONTEXT` in
 *      @fretik/ai's environment (e.g. 30000) so the threshold fires
 *      on a 10-turn history. Revert after the eval run.
 */

import { seedLargeFakeHistory } from "../conversation-lifecycle";
import type { EvalSuite } from "../types";

export const compactionSuite: EvalSuite = {
  name: "compaction",
  summary:
    "Ratio-based compaction preserves domain identifiers and file paths.",
  cases: [
    {
      id: "compaction-preserve-filename",
      description:
        "After compaction, the assistant still knows which file was uploaded earlier",
      prompt:
        "Reprends l'analyse du fichier invoice.pdf qu'on a commencé plus tôt dans la conversation et donne-moi le total TTC.",
      tags: ["compaction", "preservation"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant references invoice.pdf by name, does not claim to have lost track of which file was uploaded, and does not hallucinate a different filename. Preservation check: the specific file path survived the summariser pass.",
        },
      ],
    },
    {
      id: "compaction-preserve-shipment-id",
      description:
        "A shipment / BL identifier mentioned earlier is still usable after compaction",
      prompt:
        "Sur l'expédition MSKU-3847291 dont on a parlé, est-ce que le BL est bien arrivé ?",
      tags: ["compaction", "preservation"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant does not ask 'which shipment?' — it uses the MSKU-3847291 identifier that was preserved verbatim by the summariser and answers about its BL status.",
        },
      ],
    },
    {
      id: "compaction-no-file-not-found",
      description:
        "Post-compaction turn asking about a previously referenced file must not claim 'I don't remember which file'",
      prompt:
        "Tu peux me relire les trois premières lignes du sidecar markdown du document qu'on a ouvert il y a une vingtaine de messages ?",
      tags: ["compaction", "preservation"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The response does NOT contain phrases like 'I don't remember which file you uploaded', 'file not found' or 'I've lost track'. If the model legitimately has no way to recover the path, it should name the file from the preserved context and call read.",
        },
      ],
    },
    {
      id: "compaction-preserve-tool-call-id",
      description:
        "A persisted-output handoff must survive compaction so the agent can still read() the saved path",
      prompt:
        "Rappelle-toi de la requête SQL dont le résultat était trop long et qu'on a enregistré en persisted-output. Lis les 100 premières lignes.",
      tags: ["compaction", "persisted-output"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant calls read('outputs/persisted/<toolCallId>.txt') (or .json) preserving the path from the earlier turn and surfaces the first 100 lines.",
        },
      ],
    },
    {
      id: "compaction-sanity-short-convo",
      description:
        "On a short conversation, compaction must NOT fire — sanity check on the threshold",
      prompt: "Quel est notre premier échange ?",
      tags: ["compaction", "guard"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant can recall the first message of the conversation verbatim — no synthetic summary should have been injected on such a short history.",
        },
      ],
    },
    {
      id: "compaction-tool-heavy-no-422",
      description:
        "A tool-heavy turn that exercises the chain `read` → answer over a long PDF on top of a > 175K-token pre-seeded history must NOT 422 — verifies the CC effective-window pattern + microcompact keep the conversation viable.",
      prompt:
        "Le fichier invoice.pdf est attaché. Lis-le et donne-moi le numéro de facture et le total TTC.",
      tags: ["compaction", "regression"],
      fixtures: ["invoice.pdf"],
      seed: (ctx) => seedLargeFakeHistory(ctx.conversationId),
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant did NOT error out with a context-window failure (no COMPACTION_FAILURE / 422 surfaced mid-stream) and produced an answer with both an invoice number AND a TTC total extracted from the PDF.",
        },
      ],
    },
    {
      id: "compaction-microcompact-clears-old-tool-results",
      description:
        "After a > 175K-token pre-seeded history, microcompact + summariser fire — the model should re-fetch the original file via read() rather than hallucinate from a (potentially cleared) old result.",
      prompt:
        "Tu peux relire les 3 premières lignes du document long-report.md que tu as déjà ouvert ?",
      fixtures: ["long-report.md"],
      tags: ["compaction", "microcompact", "preservation"],
      seed: (ctx) => seedLargeFakeHistory(ctx.conversationId),
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["read"],
          mode: "any",
        },
        {
          type: "judge",
          rubric:
            "The assistant calls read() on the original file path to recover the first three lines verbatim, rather than fabricating them from memory of an older (potentially cleared) tool result.",
        },
      ],
    },
    {
      id: "compaction-runtime-state-survives",
      description:
        "After a > 175K-token pre-seeded history that activates listDocuments/querySql via searchTools and records pending manageTasks, compaction must preserve those — the model should use them without re-running searchTools.",
      prompt: "Continue la tâche qu'on était en train de faire.",
      tags: ["compaction", "runtime-state", "regression"],
      seed: (ctx) =>
        seedLargeFakeHistory(ctx.conversationId, {
          includeSearchTools: true,
          includeManageTasks: true,
        }),
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant did NOT call searchTools to re-discover domain tools — it either calls a previously-activated domain tool directly (listDocuments / querySql / getExtractionData / …) or asks the user a clarifying question that references prior context. Re-running searchTools as the very first action is a failure (it means the post-compact runtime state was lost).",
        },
      ],
    },
  ],
};
