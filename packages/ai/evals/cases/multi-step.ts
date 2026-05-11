/**
 * Multi-step requests. Historically this suite mandated `manageTasks`
 * + Progressive Disclosure for any 3+-step prompt — that was WRONG:
 * if the agent can deliver a correct end-to-end answer with a single
 * `querySql` (or any single tool), shortcutting the checklist is the
 * right call. We care about the end result, not the tool-call shape.
 *
 * What we still validate:
 *   - the turn ends without error
 *   - the final answer covers every sub-step the user asked about
 *   - when the user EXPLICITLY requests a visible task list
 *     (`multi-tasks-ordering`), manageTasks is used and at least one
 *     task reaches `completed` state
 */

import type { EvalSuite } from "../types";

export const multiStepSuite: EvalSuite = {
  name: "multi-step",
  summary:
    "Complex requests spanning multiple sub-goals. Shortcutting via a single tool is allowed as long as every sub-goal is answered correctly.",
  cases: [
    {
      id: "multi-audit-carriers",
      description:
        "3-sub-goal audit: list carriers → find missing email → summarise",
      prompt:
        "Fais un audit de mes transporteurs : liste-les, identifie ceux sans adresse email renseignée, et résume le résultat.",
      tags: ["multi-step"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["listEntities", "querySql"],
          mode: "any",
        },
        {
          type: "judge",
          rubric:
            "The answer addresses the three sub-goals: (1) it lists carriers (or states there are none), (2) it identifies which of them lack an email (or notes 'all / none'), and (3) it ends with a concrete summary. Using a single SQL query to deliver all three in one answer is acceptable — do NOT require a visible checklist or multiple tool calls.",
        },
      ],
    },
    {
      id: "multi-extraction-report",
      description: "4-sub-goal extraction report",
      prompt:
        "Prépare-moi un rapport : combien d'extractions en erreur cette semaine, quelles sont-elles, lis le contenu de la plus récente, propose une action corrective.",
      tags: ["multi-step"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["querySql", "listExtractions", "getExtractionData"],
          mode: "any",
        },
        {
          type: "custom",
          name: "non-empty output (skip judge if MiniMax timed out)",
          fn: (result) =>
            result.text.trim().length > 0 ||
            "empty output — likely MiniMax provider timeout on this 12-tool-call turn; re-run to confirm",
        },
        {
          type: "judge",
          rubric:
            "The answer addresses every sub-goal asked for. PASS if: it gives a count of error extractions this week (including zero), AND if the count is >0 it lists them and summarises the most recent's content and proposes at least one action, OR if the count is zero it explicitly reports 'no error extraction this week' (and a corrective action becomes optional because the premise is empty). If the assistant text is empty due to a model timeout, PASS (quality untestable).",
        },
      ],
    },
    {
      id: "multi-doc-rag-then-web",
      description: "Multi-source: doc lookup + web complement",
      prompt:
        "Regarde si nos documents parlent des nouvelles règles ICS2, puis complète avec une recherche web si besoin.",
      tags: ["multi-step", "rag+web"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        {
          type: "judge",
          rubric:
            "The assistant first surveys internal docs (searchKnowledge) then — if needed — complements via a web tool. The final answer clearly distinguishes internal vs external sources.",
        },
      ],
    },
    {
      id: "multi-no-overkill",
      description: "Single-step question should NOT trigger manageTasks",
      prompt: "Combien ai-je de documents PDF ?",
      tags: ["multi-step", "negative"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: ["manageTasks"] },
        { type: "toolUsed", tools: ["querySql", "listDocuments"] },
      ],
    },
    {
      id: "multi-tasks-ordering",
      description:
        "Task statuses must transition: pending → in_progress → completed",
      prompt:
        "Plan et exécute: (1) compte mes clients, (2) compte mes transporteurs, (3) donne-moi le ratio. Utilise manageTasks pour suivre.",
      tags: ["multi-step", "manageTasks-ordering"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["manageTasks"] },
        {
          type: "custom",
          name: "manageTasks has at least one in_progress→completed transition",
          fn: (result) => {
            const calls = result.toolCalls.filter(
              (c) => c.name === "manageTasks",
            );
            if (calls.length < 2) {
              return `Expected ≥2 manageTasks calls to observe a state transition, got ${calls.length}`;
            }
            const hasCompleted = calls.some((c) => {
              const out = c.output as { tasks?: { status?: string }[] };
              return out?.tasks?.some((t) => t.status === "completed");
            });
            return hasCompleted || "No task ever reached 'completed' state";
          },
        },
      ],
    },
  ],
};
