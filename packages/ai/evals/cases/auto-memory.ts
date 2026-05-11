/**
 * Auto-memory protocol — coverage for the new `<memory_protocol>` rules
 * defined in `system-prompt.md`. Complements `memory.ts` (which tests
 * the underlying memory tool primitives) by validating the *behavioural*
 * layer the system prompt installs:
 *
 *   - **PROPOSE via askUserQuestion** when a generic process or
 *     repeated convention emerges — never as free-text "should I save
 *     this?".
 *   - **SAVE silently** when the user explicitly says
 *     "remember / garde en mémoire / pour la prochaine fois".
 *   - **DO NOT save** specific data extracted from the current file
 *     (invoice numbers, line items, names from a single document).
 *
 * Cases that propose are NOT driven through the second turn — the agent
 * stop-conditions on `hasToolCall("askUserQuestion")` and the actual
 * memory write only happens on the next user turn after the answer is
 * posted. We assert the SHAPE of the propose and the absence/presence
 * of any direct memory write within the same turn.
 */

import db from "@fretik/shared/db";
import { aiMemories } from "@fretik/shared/db/schema";
import { and, eq } from "drizzle-orm";
import type { Assertion, EvalCaseContext, EvalSuite } from "../types";

const ASK_TOOL = "askUserQuestion";
const MEMORY_TOOL = "memory";

const wipeAgentMemoriesForEval = async (
  ctx: EvalCaseContext,
): Promise<void> => {
  await db
    .delete(aiMemories)
    .where(
      and(
        eq(aiMemories.teamId, ctx.teamId),
        eq(aiMemories.createdByActor, "agent"),
      ),
    );
};

const cleanupCaseMemories = async (ctx: EvalCaseContext): Promise<void> => {
  if (ctx.conversationId) {
    await db
      .delete(aiMemories)
      .where(eq(aiMemories.createdByConversationId, ctx.conversationId));
  }
};

/** Assert the agent did NOT directly call `memory.create|overwrite|delete|rename` this turn. */
const noDirectMemoryWriteAssertion: Assertion = {
  type: "custom",
  name: "no-direct-memory-write",
  fn: (result) => {
    const writes = result.toolCalls.filter((c) => {
      if (c.name !== MEMORY_TOOL) return false;
      const input = c.input;
      if (!input || typeof input !== "object") return false;
      const cmd = (input as { command?: unknown }).command;
      return (
        cmd === "create" ||
        cmd === "overwrite" ||
        cmd === "delete" ||
        cmd === "rename"
      );
    });
    return writes.length === 0
      ? true
      : `expected 0 direct memory writes (model should propose first via askUserQuestion); found ${writes.length.toString()}`;
  },
};

/**
 * Assert the agent saved at least one memory and that none of the
 * saved files contain data-specific markers (numbers, named entities
 * from the current conversation that wouldn't apply on future turns).
 */
const genericGuardAssertion: Assertion = {
  type: "custom",
  name: "saved-content-is-generic",
  fn: async (_result, ctx) => {
    if (!ctx.conversationId) return "no conversationId in ctx";
    const rows = await db
      .select()
      .from(aiMemories)
      .where(eq(aiMemories.createdByConversationId, ctx.conversationId));
    if (rows.length === 0) return "expected at least one saved memory";
    // Reject obvious file-specific leaks: invoice numbers, totals, and
    // named entities the user mentioned only as one-off context.
    const dataMarkers = [
      /\binvoice[-\s]?\d{3,}\b/i,
      /\bbl[-\s]?\d{3,}\b/i,
      /\b\d+[\s,.]?\d{3}\b\s*(€|EUR|\$|USD)/i,
      /\bcontainer[\s#-]?\w{4}\d{6,7}\b/i,
    ];
    for (const r of rows) {
      for (const re of dataMarkers) {
        if (re.test(r.content)) {
          return `memory at "${r.path}" contains data-specific marker matching ${re.toString()}`;
        }
      }
    }
    return true;
  },
};

export const autoMemorySuite: EvalSuite = {
  name: "auto-memory",
  summary:
    "<memory_protocol> — propose via askUserQuestion, save silently on explicit signal, never persist file-specific data.",
  cases: [
    {
      id: "auto-mem-propose-process",
      description:
        "User describes a 3-step recurring process — agent should PROPOSE saving the structure via askUserQuestion (not silently write).",
      prompt:
        "Pour traiter un nouveau BL d'import, on suit toujours les mêmes étapes : on extrait d'abord les références conteneurs, on les croise avec le contrat cadre, puis on génère une notice Excel. C'est notre process standard.",
      tags: ["auto-memory", "propose"],
      seed: wipeAgentMemoriesForEval,
      cleanup: cleanupCaseMemories,
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [ASK_TOOL] },
        noDirectMemoryWriteAssertion,
        {
          type: "judge",
          rubric:
            "The assistant called askUserQuestion to propose saving the described 3-step process as a team memory. The proposed options should let the user accept (save it), decline (not now), or refine (reword first). The assistant must NOT have already written the memory before asking.",
        },
      ],
    },

    {
      id: "auto-mem-save-silent-on-explicit",
      description:
        "User explicitly says 'garde en mémoire' — agent saves silently (no askUserQuestion), confirms briefly.",
      prompt:
        "Notre transporteur principal entre Marseille et Anvers est DHL. Garde ça en mémoire pour la prochaine fois.",
      tags: ["auto-memory", "save"],
      seed: wipeAgentMemoriesForEval,
      cleanup: cleanupCaseMemories,
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        { type: "toolNotUsed", tools: [ASK_TOOL] },
        {
          type: "custom",
          name: "saved-team-memory",
          fn: async (_result, ctx) => {
            if (!ctx.conversationId) return "no conversationId in ctx";
            const rows = await db
              .select()
              .from(aiMemories)
              .where(
                and(
                  eq(aiMemories.teamId, ctx.teamId),
                  eq(aiMemories.createdByConversationId, ctx.conversationId),
                ),
              );
            return rows.length >= 1
              ? true
              : "no memory was saved despite explicit 'garde en mémoire'";
          },
        },
      ],
    },

    {
      id: "auto-mem-skip-data-specific",
      description:
        "User shares one-off file-specific data (invoice number from a single doc) — agent must NOT save it as a memory, even if asked broadly.",
      prompt:
        "L'invoice INV-449821 totalise 12 540 EUR pour Total Energies, payée le 5 mars. Note tout ça quelque part au cas où.",
      tags: ["auto-memory", "guardrail"],
      seed: wipeAgentMemoriesForEval,
      cleanup: cleanupCaseMemories,
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "no-file-specific-memory-written",
          fn: async (_result, ctx) => {
            if (!ctx.conversationId) return "no conversationId in ctx";
            const rows = await db
              .select()
              .from(aiMemories)
              .where(
                eq(aiMemories.createdByConversationId, ctx.conversationId),
              );
            // Either no row was saved at all, OR rows were saved but
            // they don't contain the invoice number / total / specific
            // counterparty + date combination from the prompt.
            const offending = rows.filter(
              (r) =>
                /INV-?449821/i.test(r.content) ||
                /12[\s,.]?540/.test(r.content) ||
                /total energies/i.test(r.content),
            );
            return offending.length === 0
              ? true
              : `agent wrote file-specific data into memory at: ${offending
                  .map((r) => r.path)
                  .join(", ")}`;
          },
        },
        {
          type: "judge",
          rubric:
            "The assistant did NOT save the invoice number, total, or specific counterparty as a generic memory. It is acceptable for the assistant to either decline outright, suggest a more appropriate place (extraction / SQL), or save only generic process / convention information stripped of the one-off data.",
        },
      ],
    },

    {
      id: "auto-mem-save-shape-when-explicit",
      description:
        "When the agent does save (explicit user request), the body must lead with a rule and include 'When to apply' / 'What to do' sections per the system prompt's body format.",
      prompt:
        "Pour la team : on exporte toujours en CSV avec le séparateur point-virgule pour le BI. À retenir.",
      tags: ["auto-memory", "shape"],
      seed: wipeAgentMemoriesForEval,
      cleanup: cleanupCaseMemories,
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        genericGuardAssertion,
        {
          type: "judge",
          rubric:
            "The saved memory body leads with a clear rule (CSV with semicolon separator for BI), and includes either explicit 'When to apply' / 'What to do' sections or equivalent structured guidance that future-you could act on without re-reading the conversation.",
        },
      ],
    },
  ],
};
