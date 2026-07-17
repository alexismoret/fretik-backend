/**
 * Doctrine cases — the behaviors the 2026-07 prompt refonte targets.
 * Each case pins ONE doctrine rule with the most deterministic signal
 * available (tool trajectory first, judge only where quality is
 * inherently subjective):
 *
 *  - plan-before-act / one-python-call-per-step (`<working_method>`)
 *  - skill gate before code (`<tool_routing>` row 1)
 *  - searchKnowledge-first for content, download only for bytes
 *  - plain non-technical language (`<communication><language>`)
 *  - proactive platform suggestions with etiquette
 *    (`<proactive_partnership>`)
 *
 * Corpus-dependent cases follow the rag-* convention: the routing
 * signal is asserted deterministically; answer quality gets a lenient
 * judge because ground truth depends on the eval team's data.
 */

import db from "@fretik/shared/db";
import { aiMemories } from "@fretik/shared/db/schema";
import { eq } from "drizzle-orm";
import type { EvalSuite } from "../types";

/**
 * Internal vocabulary that must never surface in a user-facing answer
 * (`<communication><language>`). Word-boundary regexes so French prose
 * ("sélection", "ragoût") never false-positives.
 */
const BANNED_INTERNAL_TERMS: readonly RegExp[] = [
  /\bSQL\b/i,
  /\bSELECT\b/,
  /\bquerySql\b/i,
  /\bsearchKnowledge\b/i,
  /\blistDocuments\b/i,
  /\bdownloadDriveDocument\b/i,
  /\bRAG\b/,
  /\bsandbox\b/i,
  /\bkernel\b/i,
  /\bembedding/i,
  /\bchunk/i,
  /\bsystem prompt\b/i,
  /\bprompt système\b/i,
];

export const doctrineSuite: EvalSuite = {
  name: "doctrine",
  summary:
    "Refonte doctrine probes: one-python-call efficiency, skill gate before code, RAG-vs-download routing, plain non-technical language, proactive suggestions with etiquette.",
  cases: [
    {
      id: "doc-python-one-call",
      description:
        "Tabular analysis lands in ONE consolidated python script, not exploratory fragments",
      prompt:
        "Analyse le fichier data.xlsx : donne-moi le nombre de lignes, la liste des colonnes, et la somme de chaque colonne numérique.",
      tags: ["doctrine", "efficiency", "python"],
      fixtures: ["data.xlsx"],
      budget: { maxToolCalls: 3, expectedTools: ["python", "read"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python"] },
        {
          type: "custom",
          name: "at most 2 python calls (1 expected; 1 spare for a genuine error retry)",
          fn: (result) => {
            const pythonCalls = result.toolCalls.filter(
              (c) => c.name === "python",
            );
            return (
              pythonCalls.length <= 2 ||
              `expected ≤2 python calls, saw ${pythonCalls.length.toString()} — fragmentation instead of one consolidated script`
            );
          },
        },
        {
          type: "judge",
          rubric:
            "PASS if the assistant reports a concrete row count, the column names, and numeric sums that are grounded in the python tool output (no fabricated numbers). FAIL if any reported figure does not appear in (or follow from) the tool outputs.",
        },
      ],
    },
    {
      id: "doc-skill-first-xlsx",
      description:
        "Excel deliverable: FIRST tool call reads skills/xlsx/SKILL.md, before any python",
      prompt:
        "Crée un fichier Excel budget_2026.xlsx avec trois postes de dépense fictifs (libellé + montant) et une ligne de total, puis montre-le-moi.",
      tags: ["doctrine", "skill-first", "generation"],
      budget: {
        maxToolCalls: 6,
        expectedTools: ["read", "python", "presentFiles"],
      },
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "first tool call is read(skills/xlsx/SKILL.md)",
          fn: (result) => {
            const first = result.toolCalls[0];
            if (!first) return "no tool calls at all";
            if (first.name !== "read") {
              return `first call was ${first.name}, expected read(skills/xlsx/SKILL.md)`;
            }
            const input = first.input as { file_path?: unknown };
            const path =
              typeof input?.file_path === "string" ? input.file_path : "";
            return (
              path.includes("skills/xlsx") ||
              `first read targeted ${path}, expected skills/xlsx/SKILL.md`
            );
          },
        },
        { type: "toolUsed", tools: ["python"] },
        { type: "toolUsed", tools: ["presentFiles"] },
      ],
    },
    {
      id: "doc-rag-first-content",
      description:
        "Content question about team documents → searchKnowledge, never a download",
      prompt: "Que disent nos documents au sujet des conditions de paiement ?",
      tags: ["doctrine", "routing", "rag"],
      budget: { maxToolCalls: 3, expectedTools: ["searchKnowledge"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        { type: "toolNotUsed", tools: ["downloadDriveDocument"] },
        {
          type: "judge",
          rubric:
            "PASS if the assistant either summarises what the retrieved documents say about payment terms (with source citations), or states plainly that nothing relevant was found. FAIL only if it fabricates document content that the tool outputs do not support.",
        },
      ],
    },
    {
      id: "doc-plain-language",
      description:
        "Non-technical user gets a plain answer — no SQL, tool names, or platform internals",
      prompt: "Combien de documents avons-nous au total ?",
      tags: ["doctrine", "language", "mechanical-validator"],
      budget: { maxToolCalls: 2, expectedTools: ["querySql", "listDocuments"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql", "listDocuments"] },
        {
          type: "custom",
          name: "answer contains no internal plumbing vocabulary",
          fn: (result) => {
            const hits = BANNED_INTERNAL_TERMS.filter((re) =>
              re.test(result.text),
            ).map((re) => re.source);
            return (
              hits.length === 0 ||
              `internal terms leaked into the user-facing answer: ${hits.join(", ")}`
            );
          },
        },
      ],
    },
    {
      id: "doc-proactive-workflow",
      description:
        "Recurring-task signal → answer FIRST, then exactly one workflow suggestion; never builds silently",
      prompt:
        "Comme chaque lundi : fais-moi le récap des documents ajoutés la semaine dernière.",
      tags: ["doctrine", "proactivity"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: ["manageWorkflow"] },
        {
          type: "judge",
          rubric:
            "PASS if the assistant (a) actually performs the requested recap using team data (or plainly reports that nothing was added last week), AND (b) afterwards offers AT MOST ONE brief suggestion to automate this recurring Monday recap, framed by its concrete benefit. An answer with no suggestion at all is a partial pass. FAIL if it pitches platform features before (or instead of) answering, makes several suggestions, or claims to have created an automation.",
        },
      ],
    },
    {
      id: "doc-proactive-memory",
      // Without this, a run where the model SAVES the rule leaves the
      // memory behind; the next run's model sees it in active memory and
      // rightly stops proposing to save — the case then flaps (observed
      // 2026-07-17: `team/processes/validation-devis.md` leftovers).
      cleanup: async (ctx) => {
        if (!ctx.conversationId) return;
        await db
          .delete(aiMemories)
          .where(eq(aiMemories.createdByConversationId, ctx.conversationId));
      },
      description:
        "A standing rule stated by the user → acknowledged and captured (or offered) as a durable memory",
      prompt:
        "Pour info : désormais, tout devis doit être validé par un manager avant d'être envoyé au client.",
      tags: ["doctrine", "proactivity", "memory"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant acknowledges the rule and either saves it as a durable team convention or offers to save it (a single clear proposal). Both direct save and propose-first are acceptable. FAIL if it ignores the rule's durable nature (treats it as chit-chat), stores an opinionated/subjective note instead of the neutral rule, or buries the acknowledgement under multiple unrelated suggestions or technical vocabulary.",
        },
      ],
    },
  ],
};
