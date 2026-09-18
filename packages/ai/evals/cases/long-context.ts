/**
 * Long-context eval suite (C3 model gate) — long-document handling
 * discipline on synthetic + real fixtures, scored mechanically (the
 * fixtures' content is deterministic).
 *
 * Two halves, measuring two different things.
 *
 * **Long DOCUMENT** (`lc-deep-retrieval`, `lc-multidoc-qa`): retrieval
 * precision inside one big file the agent reads with a tool. Deliberately
 * lean — session 8 reverted a 36-page OCR case for making full runs too long.
 *
 * **Long CONVERSATION** (`lc-recall-*`): what the agent still knows about its
 * own history after that history has been reduced. Added 2026-09-17, when
 * `EvalCase.history` made a seeded multi-turn conversation possible; until
 * then this was the gap `evals/BACKLOG.md` named twice and the reason nothing
 * measured the compaction work.
 *
 * The three sizes are not a sweep, they are three REGIMES, and each one is the
 * smallest history that reaches the next mechanism:
 *
 * | Target  | What fires                                                   |
 * | ------- | ------------------------------------------------------------ |
 * |  40 000 | nothing — the control. Proves the needle is recoverable.      |
 * | 120 000 | `AGENT_CONTEXT_CEILING_TOKENS` (100 000) → the TURN BOUNDARY. |
 * | 340 000 | `CHATBOT_COMPACTION_CAP` (300 000) → `compactConversation`.   |
 *
 * A failure at 40 000 is a broken harness; a failure at 120 000 or 340 000 is
 * the boundary summary losing a fact, which is the one accuracy risk the
 * design cannot remove by construction. Run the three together or none of
 * them: the control is what tells the two apart.
 *
 * The control arm for an A/B is `AGENT_CONTEXT_CEILING_TOKENS=1000000` — the
 * ceiling effectively disarmed, same binary, nothing to branch on.
 *
 * **How these two cases can pass while measuring nothing.** The summariser
 * reads the whole transcript, and the transcript's last message is this
 * case's own question. Measured 2026-09-18 on the traces of a real run: the
 * summariser ANSWERED it — `RCN-8842-QK`, eleven characters — and that string
 * was installed as the conversation's entire memory. The agent then read the
 * needle straight out of the compaction summary and the case scored 1.000,
 * having exercised no recall whatsoever. Two guards close it, both in
 * `services/compaction/prompt.ts` and both load-bearing FOR THIS SUITE and
 * not only for production: the instruction is placed after the transcript,
 * and a response without the `<summary>` envelope is refused rather than
 * installed. Weaken either and these cases go green for the wrong reason,
 * which is worse than red.
 */

import { buildLongHistory } from "../history";
import type { EvalCase, EvalSuite } from "../types";

/**
 * Stated once, in the assistant's narration on the oldest exchange, and never
 * restated. Shaped so it cannot be guessed, recomputed, or reached with a tool
 * — the ledger files the history talks about were never written to the
 * sandbox, so the only surviving copy is the conversation itself.
 */
const NEEDLE = {
  statement:
    "Le lot de rapprochement de référence porte le code RCN-8842-QK, et l'écart résiduel validé s'élève à 41 328,60 €.",
  expected: "RCN-8842-QK",
} as const;

/**
 * What the user ASKED FOR, said once in their opening message and never again.
 *
 * The needle above is a value, and every summariser prompt in the industry has
 * a section ordering the model to keep values verbatim — section 2 of ours
 * says "List ALL load-bearing domain identifiers … VERBATIM". So `lc-recall-*`
 * measures the section that is hardest to get wrong. This measures the one
 * that is easiest to lose: an objective and a constraint are not facts about
 * the work, they are the reason for it, and a summariser reading a transcript
 * of CSV dumps and reconciliations has nothing pulling it towards them.
 *
 * Both halves are load-bearing and neither is guessable from the filler: the
 * deliverable is a document type and an audience the transcript never
 * mentions again, and the constraint is a rule that would change the shape of
 * every answer that followed if the model still knew it.
 */
const INTENT = {
  statement:
    "Rappel de cadrage, je ne le redirai pas : l'objectif final de tout ce travail est une note de synthèse de trois pages destinée au comité d'investissement du 30 septembre, et tous les montants que tu me donnes doivent être exprimés hors taxes, jamais TTC.",
  expected: ["note de synthèse", "comité d'investissement", "hors taxes"],
} as const;

const recallCase = (id: string, targetTokens: number): EvalCase => {
  const history = buildLongHistory({ seed: id, targetTokens, needle: NEEDLE });
  return {
    id,
    description: `Recall of a fact stated in the oldest turn, across ~${Math.round(history.estimatedTokens / 1000)}K tokens of seeded history`,
    prompt:
      "Quel est le code du lot de rapprochement de référence dont je t'ai parlé plus haut dans cette conversation ? Réponds depuis l'historique, ne relis aucun fichier, et donne uniquement le code.",
    tags: ["long-context", "compaction"],
    history: history.turns,
    assertions: [
      { type: "noError" },
      { type: "contains", value: NEEDLE.expected },
      // The failure that matters is not silence, it is a confident wrong
      // code — a summary that kept the SHAPE of the fact and lost its value.
      // Anything matching the pattern but not the needle fails the case
      // above; this pins that no OTHER code is offered alongside it.
      { type: "toolNotUsed", tools: ["read"] },
    ],
  };
};

/**
 * The same three regimes, asking what the USER wanted rather than what a
 * ledger said. Only the two sizes that actually reduce the history are worth
 * running: below the cap nothing is dropped, so a pass would say nothing about
 * the summary.
 */
const intentCase = (id: string, targetTokens: number): EvalCase => {
  const history = buildLongHistory({
    seed: id,
    targetTokens,
    needle: NEEDLE,
    intent: INTENT,
  });
  return {
    id,
    description: `Recall of the objective and the constraint the user stated once, across ~${Math.round(history.estimatedTokens / 1000)}K tokens of seeded history`,
    prompt:
      "Avant qu'on aille plus loin : rappelle-moi ce que je t'ai demandé de produire au tout début de cette conversation, pour qui, et la contrainte de présentation des montants que j'avais posée. Réponds depuis l'historique, ne relis aucun fichier.",
    tags: ["long-context", "compaction"],
    history: history.turns,
    assertions: [
      { type: "noError" },
      ...INTENT.expected.map((value) => ({
        type: "contains" as const,
        value,
      })),
      { type: "toolNotUsed", tools: ["read"] },
    ],
  };
};

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
    recallCase("lc-recall-40k", 40_000),
    recallCase("lc-recall-120k", 120_000),
    recallCase("lc-recall-340k", 340_000),
    intentCase("lc-intent-120k", 120_000),
    intentCase("lc-intent-340k", 340_000),
  ],
};
