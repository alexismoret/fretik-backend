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
import { readTeamDigest } from "@fretik/shared/services/memory-digest/read";
import { buildTeamDigest } from "../../src/services/memory/build-team-digest";
import { consolidateEpisodes } from "../../src/services/memory/consolidate-episodes";
import { distillConversation } from "../../src/services/memory/distill-conversation";
import { promoteEpisodes } from "../../src/services/memory/promote-episodes";
import { runUnifiedRecall } from "../../src/services/recall/recall";
import { textIncludes } from "../text-match";
import {
  type ChainFixtures,
  DIGEST_CONVENTION_MARK,
  DIGEST_CONVENTION_PATH,
  DIGEST_PRIVATE_EPISODE_MARK,
  DIGEST_PRIVATE_MARK,
  makeContradictionPair,
  makeConventionCluster,
  makeDigestInputs,
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
  /**
   * Hand recall the standing digest, as `/stream` does. Off by default so the
   * pre-digest cases keep measuring what they always measured.
   */
  withDigest = false,
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
    ...(withDigest ? { digestPromise: readTeamDigest(fx.teamId) } : {}),
  });
  return result?.block ?? "";
};

/** What the digest may cost in the prompt — the generator's own ceiling. */
const DIGEST_TOKEN_BUDGET = 1_200;

/**
 * Rewrite the team's digest and read back what was STORED.
 *
 * Reading the row rather than the builder's return value on purpose: the row
 * is what every turn is served, and a build that fails keeps the previous
 * digest — a case scored on the return value would call that a pass.
 */
const rewriteDigest = async (
  fx: ChainFixtures,
): Promise<{ status: string; content: string; tokenCount: number }> => {
  const result = await buildTeamDigest({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    force: true,
  });
  const row = await readTeamDigest(fx.teamId);
  return {
    status: result.status,
    content: row?.content ?? "",
    tokenCount: row?.tokenCount ?? 0,
  };
};

/**
 * Every marker in the digest that names a row the database does not have.
 *
 * The generator gates its output against the handle map it built itself, which
 * cannot catch a row deleted between the build and the turn — and the digest
 * is served for as long as a day.
 */
const unresolvedMarkers = async (
  fx: ChainFixtures,
  content: string,
): Promise<string[]> => {
  const missing: string[] = [];
  for (const [, kind, id] of content.matchAll(
    /\((memory|episode|record):([^)\s]+)\)/g,
  )) {
    if (kind === undefined || id === undefined) continue;
    const found =
      kind === "memory"
        ? await db.query.aiMemories.findFirst({
            where: { teamId: fx.teamId, path: id },
            columns: { id: true },
          })
        : kind === "episode"
          ? await db.query.aiEpisodes.findFirst({
              where: { id, teamId: fx.teamId },
              columns: { id: true },
            })
          : await db.query.collectionRecords.findFirst({
              where: { id, teamId: fx.teamId },
              columns: { id: true },
            });
    if (!found) missing.push(`${kind}:${id}`);
  }
  return missing;
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
  {
    id: "chain-digest",
    description:
      "Layer 0 end to end: memory and episode writes → digest rewrite → what the digest states → what recall then leaves out. One case rather than four because all four claims are about the SAME generated digest — four cases meant four model calls per repeat to score one artefact.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];
      /** Prefixed so a failure names its concern, as every chain case does. */
      const fail = (concern: string, detail: string): number =>
        failures.push(`${concern}: ${detail}`);

      const seed = await makeDigestInputs(fx);
      const digest = await rewriteDigest(fx);
      lines.push(
        `[digest] ${digest.status} ${digest.tokenCount.toString()} tokens\n${digest.content || "NONE"}`,
      );
      if (digest.content.length === 0) {
        return { text: lines.join("\n\n"), failures: ["digest: vide"] };
      }

      // 1. A team convention reaches the standing digest, attributed to the
      //    path it actually came from.
      if (!has(digest.content, DIGEST_CONVENTION_MARK)) {
        fail("convention", "la convention d'équipe n'est pas dans le digest");
      }
      if (!digest.content.includes(`memory:${DIGEST_CONVENTION_PATH}`)) {
        fail("convention", "la convention n'est pas attribuée à son chemin");
      }

      // 2. Nothing private does. Not a quality miss if this breaks — the
      //    digest is served to every member on every turn, and no stage after
      //    it re-checks scope.
      if (digest.content.includes(DIGEST_PRIVATE_MARK)) {
        fail("privacy", "une note PRIVÉE est servie à toute l'équipe");
      }
      if (digest.content.includes(seed.privatePath)) {
        fail("privacy", "le chemin de la note privée est cité");
      }
      if (digest.content.includes(DIGEST_PRIVATE_EPISODE_MARK)) {
        fail("privacy", "un épisode PRIVÉ est servi à toute l'équipe");
      }

      // 3. Of two episodes 38 days apart, the current value is the one stated.
      //    The stale one is not banned — "800 (previously 1 200)" is BETTER
      //    than dropping the history. Asserting it as if it still held is.
      if (!has(digest.content, seed.freshValue)) {
        fail(
          "currency",
          `la valeur courante (${seed.freshValue} €) n'est pas dans le digest`,
        );
      }
      for (const line of digest.content
        .split("\n")
        .filter((l) => has(l, seed.staleValue))) {
        if (!/previously|auparavant|précédemment|precedemment/i.test(line)) {
          fail(
            "currency",
            `la valeur périmée (${seed.staleValue} €) est affirmée sans « previously » — « ${line.trim()} »`,
          );
        }
      }

      // 4. It fits the prompt budget, every marker resolves against the
      //    DATABASE (not the handle map the generator built for itself), and
      //    no heading spends budget on an empty section.
      if (digest.tokenCount > DIGEST_TOKEN_BUDGET) {
        fail(
          "budget",
          `${digest.tokenCount.toString()} tokens > ${DIGEST_TOKEN_BUDGET.toString()}`,
        );
      }
      for (const marker of await unresolvedMarkers(fx, digest.content)) {
        fail("budget", `le marqueur ${marker} ne résout sur rien`);
      }
      const contentLines = digest.content.split("\n");
      for (const [i, line] of contentLines.entries()) {
        if (!line.trim().startsWith("#")) continue;
        const rest = contentLines.slice(i + 1).find((l) => l.trim().length > 0);
        if (rest === undefined || rest.trim().startsWith("#")) {
          fail("budget", `section vide « ${line.trim()} »`);
        }
      }

      // 5. Recall then leaves out what the digest already says. Both arms, one
      //    question, one corpus: without the paired no-digest run the check
      //    passes on a block that simply never retrieved the convention.
      const question =
        "Qu'est-ce qu'on doit faire à la réception d'une livraison Calliope Verre ?";
      const withoutDigest = await recallFor(fx, question);
      const withDigest = await recallFor(fx, question, true);
      lines.push(`[recall sans digest]\n${withoutDigest || "NONE"}`);
      lines.push(`[recall avec digest]\n${withDigest || "NONE"}`);

      const marker = `memory:${DIGEST_CONVENTION_PATH}`;
      if (!withoutDigest.includes(marker)) {
        fail(
          "dedup",
          "la convention n'est pas retrouvable — la suppression ne prouve rien",
        );
      } else if (withDigest.includes(marker)) {
        fail("dedup", "la convention est rendue deux fois — digest ET bloc");
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
];
