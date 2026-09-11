/**
 * Chain-eval cases — the memory pipeline scored END TO END.
 *
 * Every other suite scores one link: `evals/memory` scores each generator
 * against fixtures, `evals/recall` scores the block against episodes seeded BY
 * HAND. Neither ever runs a real distiller's output through recall, so nothing
 * measures the composition — and four stages at 95 % make 81 %.
 *
 * Each case runs the production services in order and asserts only on the FINAL
 * memory block, but checks every stage on the way through so a failure NAMES
 * ITS STAGE (`distill:` / `consolidate:` / `promote:` / `recall:`). Attribution
 * is the whole point: a decision missing from the block is a different bug
 * depending on whether the distiller dropped it or recall failed to bring it
 * back.
 */

import db from "@fretik/shared/db";
import { consolidateEpisodes } from "../../src/services/memory/consolidate-episodes";
import { distillConversation } from "../../src/services/memory/distill-conversation";
import { promoteEpisodes } from "../../src/services/memory/promote-episodes";
import { runUnifiedRecall } from "../../src/services/recall/recall";
import { textIncludes } from "../text-match";
import {
  type ChainFixtures,
  makeContradictionPair,
  makeConventionCluster,
  makeOneOffCluster,
  waitForMemoryVectors,
} from "./fixtures";

export interface ChainCaseResult {
  /** Every stage's output, printed for human analysis. */
  text: string;
  /** Empty = pass. Each entry is prefixed with the stage that failed. */
  failures: string[];
}

export interface ChainEvalCase {
  id: string;
  description: string;
  run: (fx: ChainFixtures) => Promise<ChainCaseResult>;
}

/** Typography-insensitive — see `evals/text-match.ts` for why that matters. */
const has = textIncludes;

/** The recall stage, run exactly as a turn would. */
const recallFor = async (
  fx: ChainFixtures,
  userMessage: string,
): Promise<string> => {
  const result = await runUnifiedRecall({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userId,
    agentType: "chatbot",
    userMessage,
    attachedFiles: [],
    recentTail: "",
    bypassCache: true,
  });
  return result?.block ?? "";
};

export const CHAIN_CASES: ChainEvalCase[] = [
  {
    id: "chain-decision-survives",
    description:
      "A decision taken in conversation must survive distillation and come back on a question that never repeats its wording: 'règlement à 30 jours net' asked as 'quel délai de paiement'.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const distilled = await distillConversation({
        conversationId: fx.decisionConversationId,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
      });
      if (!distilled.distilled || !distilled.episodeId) {
        return { text: "(no episode)", failures: ["distill: aucun épisode"] };
      }
      const episode = await db.query.aiEpisodes.findFirst({
        where: { id: distilled.episodeId },
        columns: { title: true, summary: true },
      });
      lines.push(
        `[distill] ${episode?.title ?? "?"}\n${episode?.summary ?? ""}`,
      );
      if (!has(episode?.summary ?? "", "30 jours")) {
        failures.push(
          "distill: la décision « 30 jours net » n'est pas dans l'épisode",
        );
      }

      const block = await recallFor(
        fx,
        "Quel délai de paiement on a arrêté avec Calliope Verre ?",
      );
      lines.push(`[recall]\n${block || "NONE"}`);
      if (block.length === 0) {
        failures.push("recall: aucun bloc alors que l'épisode existe");
      } else {
        if (!block.includes(`episode:${distilled.episodeId}`)) {
          failures.push("recall: l'épisode distillé n'est pas cité");
        }
        if (!has(block, "30")) {
          failures.push("recall: la décision n'est pas remontée dans le bloc");
        }
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-contradiction-corrected",
    description:
      "Two episodes state incompatible production lead times (8 weeks, then 3). Consolidation must resolve it, and recall must surface the CURRENT value — never the superseded one as if it still held.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const { staleId, freshId } = await makeContradictionPair(fx);
      const result = await consolidateEpisodes({
        episodeIds: [staleId, freshId],
        teamId: fx.teamId,
        organizationId: fx.organizationId,
      });
      lines.push(`[consolidate] action=${result.action}`);
      if (result.action === "NOOP" || !result.episodeId) {
        failures.push("consolidate: NOOP sur deux épisodes contradictoires");
      } else {
        const survivor = await db.query.aiEpisodes.findFirst({
          where: { id: result.episodeId },
          columns: { title: true, summary: true },
        });
        lines.push(`${survivor?.title ?? "?"}\n${survivor?.summary ?? ""}`);
        if (!has(survivor?.summary ?? "", "3 semaine")) {
          failures.push(
            "consolidate: le survivant ne porte pas le délai courant",
          );
        }
      }

      const block = await recallFor(
        fx,
        "C'est quoi le délai de production actuel chez Calliope Verre ?",
      );
      lines.push(`[recall]\n${block || "NONE"}`);
      if (block.length === 0) {
        failures.push("recall: aucun bloc");
      } else if (!has(block, "3 semaine")) {
        failures.push(
          "recall: le délai courant (3 semaines) n'est pas remonté",
        );
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-convention-promoted",
    description:
      "One convention restated across three episodes must be promoted to a learned memory AND then cited as a FACT on a differently-worded question — the episodic→semantic hop, verified at the recall end rather than at the promoter's return value.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const episodeIds = await makeConventionCluster(fx);
      const result = await promoteEpisodes({
        episodeIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
      });
      lines.push(
        `[promote] added=${result.added.toString()} updated=${result.updated.toString()} noop=${result.noop.toString()}`,
      );
      const written = await db.query.aiMemories.findMany({
        where: { teamId: fx.teamId, path: { like: "learned/%" } },
        columns: { path: true, content: true },
      });
      const mine = written.filter((m) => has(m.content, "Calliope"));
      for (const m of mine) lines.push(`${m.path}\n${m.content}`);
      if (result.added + result.updated === 0 || mine.length === 0) {
        failures.push(
          "promote: aucune mémoire learned/ écrite sur une convention récurrente",
        );
      }
      // The write is fire-and-forget on the vector; wait for retrievability so
      // this case measures the chain and not the embedding race.
      if (!(await waitForMemoryVectors(fx.teamId, "Calliope"))) {
        failures.push("promote: la mémoire écrite n'a jamais été vectorisée");
      }

      const block = await recallFor(
        fx,
        "Je prépare une commande pour Calliope Verre, quelque chose à respecter ?",
      );
      lines.push(`[recall]\n${block || "NONE"}`);
      if (block.length === 0) {
        failures.push(
          "recall: aucun bloc alors qu'une mémoire learned/ existe",
        );
      } else if (!has(block, "double exemplaire")) {
        failures.push("recall: la convention promue n'est pas remontée");
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-oneoff-not-durable",
    description:
      "Two unrelated one-off facts about the same entity must NOT become a durable team memory — and, above all, must not reach the assistant as a FACT. The over-generalization guard checked where it actually costs something.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const episodeIds = await makeOneOffCluster(fx);
      const result = await promoteEpisodes({
        episodeIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
      });
      lines.push(
        `[promote] added=${result.added.toString()} updated=${result.updated.toString()} noop=${result.noop.toString()}`,
      );
      const written = await db.query.aiMemories.findMany({
        where: { teamId: fx.teamId, path: { like: "learned/%" } },
        columns: { path: true, content: true },
      });
      const mine = written.filter((m) => has(m.content, "Calliope"));
      for (const m of mine) lines.push(`${m.path}\n${m.content}`);
      if (mine.length > 0) {
        failures.push(
          `promote: ${mine.length.toString()} mémoire(s) learned/ écrite(s) sur des faits ponctuels`,
        );
      }

      const block = await recallFor(
        fx,
        "Je prépare une commande pour Calliope Verre, quelque chose à respecter ?",
      );
      lines.push(`[recall]\n${block || "NONE"}`);
      if (block.includes("memory:learned/")) {
        failures.push(
          "recall: une mémoire learned/ inventée remonte comme un fait",
        );
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
];
