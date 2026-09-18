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
import { assembleContextFragments } from "../../src/agents/shared/fragments";
import { STANDING_MODE } from "../../src/agents/shared/standing-memory";
import { recallForWorkflowTurnOne } from "../../src/agents/workflow/turn-one-memory";
import { consolidateEpisodes } from "../../src/services/memory/consolidate-episodes";
import { distillConversation } from "../../src/services/memory/distill-conversation";
import { promoteEpisodes } from "../../src/services/memory/promote-episodes";
import { runUnifiedRecall } from "../../src/services/recall/recall";
import { textIncludes } from "../text-match";
import {
  type ChainFixtures,
  ensureWorkflowConventionMemory,
  HEAVY_WORKFLOW_TOKEN,
  makeContradictionPair,
  makeConventionCluster,
  makeHeavyWorkflowRun,
  makeOneOffCluster,
  makeWorkflowRun,
  waitForMemoryVectors,
  WORKFLOW_GOAL,
  WORKFLOW_MEMORY_LEAF,
  WORKFLOW_MEMORY_PATH,
  WORKFLOW_NAME,
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
  /**
   * Needs a LIVE `@fretik/ai` service and `TRIGGER_CALLBACK_KEY` — opt-in with
   * `--e2e`, because every other case in this suite runs in-process and a
   * missing service would otherwise read as a pipeline failure.
   */
  e2e?: boolean;
  run: (fx: ChainFixtures) => Promise<ChainCaseResult>;
}

/** Typography-insensitive — see `evals/text-match.ts` for why that matters. */
const has = textIncludes;

/**
 * The `learned/` memories THIS promotion wrote, by provenance.
 *
 * Not by entity name, which is what these cases used and what took
 * `chain-convention-promoted` to 27/30 at N=30 while the promoter was working
 * perfectly on all thirty. Its prompt says "Keep it generic — no
 * episode-specific one-off details", so it sometimes writes "Pour chaque
 * commande, l'équipe achats envoie le bon de commande en double exemplaire
 * signé" — the rule, correctly generalized, with the supplier's name nowhere
 * in it. A filter on the name then finds nothing and the case fails for the
 * promoter doing its job BEST.
 *
 * Worse in the mirror case: `chain-oneoff-not-durable` asserts NO memory was
 * written, so an over-generalized one-off that happens not to name the entity
 * passed a guard that exists to catch exactly that.
 *
 * `Sources: episode:<id>` is stamped by the writer on every promotion and
 * cannot be reworded, so it identifies the rows regardless of what the model
 * decided to call them.
 */
const writtenFrom = (
  memories: { path: string; content: string }[],
  episodeIds: string[],
): { path: string; content: string }[] =>
  memories.filter((m) => episodeIds.some((id) => m.content.includes(id)));

/**
 * Drive ONE workflow turn over the route the Trigger.dev orchestrator calls.
 *
 * Not a mock of it — the whole point of the e2e case is that nothing between
 * the run row and the model is stubbed. The response is SSE; the turn's
 * verdict arrives as the `result` event, and heartbeats stream until it does.
 */
const runWorkflowTurn = async (
  runId: string,
  turnIndex = 1,
): Promise<{ status: string; detail: string; usage?: TurnUsageFrame }> => {
  const base = process.env.AI_SERVICE_URL ?? "";
  const key = process.env.TRIGGER_CALLBACK_KEY ?? "";
  if (!base || !key) {
    return {
      status: "failed",
      detail: "AI_SERVICE_URL / TRIGGER_CALLBACK_KEY manquants pour --e2e",
    };
  }
  const res = await fetch(`${base}/internal/trigger/runs/${runId}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trigger-Key": key },
    body: JSON.stringify({ turnIndex, wrapUp: false }),
  });
  if (!res.ok || !res.body) {
    return { status: "failed", detail: `HTTP ${res.status.toString()}` };
  }
  const text = await res.text();
  // Last `result` frame wins; the stream also carries heartbeats and deltas.
  const frames = text.split("\n\n").filter((f) => f.includes("event: result"));
  const last = frames.at(-1);
  if (!last) return { status: "failed", detail: "aucun événement result" };
  const dataLine = last
    .split("\n")
    .find((l) => l.startsWith("data: "))
    ?.slice(6);
  if (!dataLine) return { status: "failed", detail: "result sans data" };
  const parsed: unknown = JSON.parse(dataLine);
  const status =
    typeof parsed === "object" &&
    parsed !== null &&
    "status" in parsed &&
    typeof parsed.status === "string"
      ? parsed.status
      : "unknown";
  return { status, detail: dataLine.slice(0, 300), usage: readUsage(parsed) };
};

/**
 * The run odometer as the `result` frame carries it — cumulative over the run,
 * not per turn (`handlers/workflow.ts::emitUsage`).
 */
interface TurnUsageFrame {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

const readUsage = (parsed: unknown): TurnUsageFrame | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("usage" in parsed)) return undefined;
  const usage: unknown = parsed.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const num = (key: string): number | undefined => {
    if (!(key in usage)) return undefined;
    const value: unknown = (usage as Record<string, unknown>)[key];
    return typeof value === "number" ? value : undefined;
  };
  return {
    totalTokens: num("totalTokens"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    cachedInputTokens: num("cachedInputTokens"),
  };
};

/**
 * Hard stop on the eval's turn loop.
 *
 * The orchestrator has no such bound — its only limit is the run's wall-clock
 * budget, which is what let run `01a0af4e` spend 42 minutes and ~6.1 M tokens
 * producing nothing on 2026-09-17. An eval needs a bound that is not a clock,
 * because a clock makes the measurement depend on how fast the provider
 * answered that afternoon.
 */
const MAX_EVAL_TURNS = 12;

export interface WorkflowRunOutcome {
  status: string;
  turns: number;
  detail: string;
  /** Cumulative, read off the last `result` frame. */
  usage?: TurnUsageFrame;
}

/**
 * Drive a run to completion, the way the orchestrator does.
 *
 * This is `tasks/workflow-run.ts`'s loop minus Trigger.dev: increment
 * `turnIndex` while the turn says `continue`, stop on a terminal status. It
 * is the missing half of the harness — `BACKLOG.md` records that "the whole
 * workflow path" had no coverage and that a workflow change was validated by
 * replaying a real run and reading the trace, and a single hardcoded
 * `turnIndex: 1` is why: a one-turn run never reloads its own history, so the
 * context ceiling, the turn boundary and the run budget were all unreachable.
 *
 * `needs_approval` is terminal HERE and only here: an eval has nobody to
 * approve, so parking on a wait token would hang the suite. A fixture that
 * reaches it has mis-specified its playbook, and the status says so.
 */
const runWorkflowToCompletion = async (
  runId: string,
): Promise<WorkflowRunOutcome> => {
  let usage: TurnUsageFrame | undefined;
  for (let turnIndex = 1; turnIndex <= MAX_EVAL_TURNS; turnIndex++) {
    // eslint-disable-next-line no-await-in-loop -- a run's turns are serial by
    // definition: turn N+1 reads the history turn N wrote.
    const turn = await runWorkflowTurn(runId, turnIndex);
    usage = turn.usage ?? usage;
    if (turn.status !== "continue") {
      return {
        status: turn.status,
        turns: turnIndex,
        detail: turn.detail,
        usage,
      };
    }
  }
  return {
    status: "turn_limit",
    turns: MAX_EVAL_TURNS,
    detail: `run non terminé après ${MAX_EVAL_TURNS.toString()} tours`,
    usage,
  };
};

/** What the run actually wrote — assistant text only, tool parts dropped. */
const assistantTextFor = async (conversationId: string): Promise<string> => {
  const messages = await db.query.aiMessages.findMany({
    where: { conversationId, role: "assistant" },
    columns: { parts: true },
  });
  return messages
    .flatMap((m) =>
      m.parts.flatMap((p) =>
        p.type === "text" && typeof p.text === "string" ? [p.text] : [],
      ),
    )
    .join("\n");
};

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
      const mine = writtenFrom(written, episodeIds);
      for (const m of mine) lines.push(`${m.path}\n${m.content}`);
      if (result.added + result.updated === 0 || mine.length === 0) {
        failures.push(
          "promote: aucune mémoire learned/ écrite sur une convention récurrente",
        );
      } else if (!mine.some((m) => has(m.content, "double exemplaire"))) {
        // The rule itself, not the supplier's name — the promoter is told to
        // generalize, so naming the entity is optional and the convention is
        // not. Same marker the recall assertion below uses.
        failures.push(
          "promote: la mémoire écrite ne porte pas la convention (double exemplaire)",
        );
      }
      // The write is fire-and-forget on the vector; wait for retrievability so
      // this case measures the chain and not the embedding race. Keyed on a
      // cited episode id for the same reason `writtenFrom` is.
      if (!(await waitForMemoryVectors(fx.teamId, episodeIds[0] ?? "—"))) {
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
      "Two unrelated one-off facts about the same entity must NOT become a durable team memory — and, if one ever is, must not reach the assistant as a FACT. The guard's teeth are at the promote stage; the recall check says the failure would have been felt, and both are scoped to what THIS cluster produced.",
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
      // By provenance, not by entity name: the failure this guard exists to
      // catch is an OVER-GENERALIZED one-off, and over-generalizing is exactly
      // what drops the entity's name from the text. See `writtenFrom`.
      const mine = writtenFrom(written, episodeIds);
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
      // The memories THIS cluster produced, not every `learned/` path in the
      // block. `memory:learned/` as a whole was a proxy that held only while
      // the team had no other promotions — and it stopped holding the day one
      // was parked here deliberately (the P5.1 acceptance residue, about
      // another supplier entirely), taking this case to 0/30 while the
      // promoter was correctly writing nothing at all.
      const leaked = mine.filter((m) => block.includes(`memory:${m.path}`));
      if (leaked.length > 0) {
        failures.push(
          `recall: ${leaked.map((m) => m.path).join(", ")} — une mémoire inventée sur des faits ponctuels remonte comme un fait`,
        );
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-workflow-turn-one",
    description:
      "A workflow run starts knowing the team's conventions. Nobody is typing, so nothing in the run names the memory — retrieval matches on the workflow's own name and goal, and the index lists the path. The two surfaces P2 put in turn 1's steering message, measured where they are produced rather than where they are formatted.",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      await ensureWorkflowConventionMemory(fx);

      // Surface 1 — the index. Names every memory, so the run can open one by
      // path even when retrieval brought nothing back.
      const fragments = await assembleContextFragments(
        {
          organizationId: fx.organizationId,
          teamId: fx.teamId,
          userId: fx.userId,
          logPrefix: "[chain-eval]",
        },
        { mode: STANDING_MODE, memory: true },
      );
      const index = fragments.memoryIndexBlock ?? "";
      lines.push(`[index]\n${index || "NONE"}`);
      // The index renders a TREE, so the full path never appears contiguously
      // — `team/` is a heading and the leaf sits under it. Assert the leaf.
      if (!has(index, WORKFLOW_MEMORY_LEAF)) {
        failures.push(`index: ${WORKFLOW_MEMORY_LEAF} n'est pas listé`);
      }

      // Surface 2 — recall, matched on the goal and nothing else. The marker
      // is absent from the goal on purpose: passing on lexical overlap would
      // prove nothing about the substitution.
      const block =
        (await recallForWorkflowTurnOne({
          organizationId: fx.organizationId,
          teamId: fx.teamId,
          conversationId: fx.decisionConversationId,
          actingUserId: fx.userId,
          workflowName: WORKFLOW_NAME,
          playbookGoal: WORKFLOW_GOAL,
          triggerPayload: { source: "chain-eval" },
          // N repeats of one case are N identical cache keys; without this the
          // suite scores one recall call N times. See the option's own note.
          bypassCache: true,
        })) ?? "";
      lines.push(`[recall/workflow]\n${block || "NONE"}`);
      // Assert the PROVENANCE, not the phrasing.
      //
      // This goal escalates to the recall judge every time (measured
      // 2026-09-12: `best=0.697`, `escalate=true` on every repeat), and the
      // judge SUMMARISES content — it is told to copy each tag exactly, never
      // each sentence. Keying on the marker "contrôle qualité photo" therefore
      // measured one model's word choice: 30/30 on 2026-09-11, 0/10 on
      // 2026-09-12 with no source change that could explain it, the judge
      // having rewritten the same memory as "photographier les colis à
      // l'arrivée…". The same mistake this suite already made once and fixed in
      // 187d098 — score the claim, not the wording.
      //
      // The claim is "a goal that never names the convention brings the
      // convention back". The memory's own path proves exactly that and is a
      // tag the judge copies verbatim; `photograph` is the concept surviving
      // any paraphrase of it.
      if (block.length === 0) {
        failures.push("recall: aucun bloc pour le tour 1 du run");
      } else if (!has(block, WORKFLOW_MEMORY_PATH)) {
        failures.push(
          `recall: la convention (${WORKFLOW_MEMORY_PATH}) n'est pas remontée sur le goal du workflow`,
        );
      } else if (!has(block, "photograph")) {
        failures.push(
          "recall: le bloc cite la convention sans en rapporter le fond (photographier les colis)",
        );
      }

      // A run with no acting user gets NO block — recall scopes private rows
      // to the caller, and a team-wide block would be the leak. Paired with
      // the assertion above, which a function returning nothing would satisfy.
      const anonymous = await recallForWorkflowTurnOne({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        conversationId: fx.decisionConversationId,
        actingUserId: undefined,
        workflowName: WORKFLOW_NAME,
        playbookGoal: WORKFLOW_GOAL,
        triggerPayload: { source: "chain-eval" },
        bypassCache: true,
      });
      if (anonymous !== undefined) {
        failures.push(
          "recall: un run sans utilisateur a reçu un bloc — le scope privé n'est plus tenu",
        );
      }

      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-workflow-convention-applied",
    e2e: true,
    description:
      "The run APPLIES the convention, not merely receives it. `chain-workflow-turn-one` proves the block is assembled; this drives a real turn through `/internal/trigger/runs/:runId/turn` — the same route the orchestrator calls — and reads what the run actually wrote. The distinction the package already draws between `evals:recall` (the block) and `memory-recall` (the answer).",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const { runId, conversationId } = await makeWorkflowRun(fx);
      const result = await runWorkflowTurn(runId);
      lines.push(`[turn] status=${result.status}`);
      if (result.status === "failed") {
        failures.push(`turn: le tour a échoué — ${result.detail}`);
      }

      const output = await assistantTextFor(conversationId);
      lines.push(`[output]\n${output || "NONE"}`);
      if (output.length === 0) {
        failures.push("turn: le run n'a produit aucun texte");
      } else if (!has(output, "photo")) {
        // The convention is in the team's memory and nowhere in the playbook.
        // A run that never read it writes a perfectly good reception procedure
        // without a photo in it.
        failures.push(
          "output: la procédure rédigée n'applique pas la convention (contrôle qualité photo)",
        );
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
  {
    id: "chain-workflow-multi-turn-ceiling",
    e2e: true,
    description:
      "A run driven to completion over MANY turns, heavy enough to cross the context ceiling twice. Asserts the three things a one-turn case structurally cannot: that the run converges at all, that the turn boundary carried a fact stated in the first task across the cut, and that the odometer counts the turn that ended the run (the 2026-09-17 incident reported `5589501 > 6000000`, a message that refutes itself, because the abandoning turn was the one missing from the total).",
    run: async (fx) => {
      const failures: string[] = [];
      const lines: string[] = [];

      const { runId, conversationId } = await makeHeavyWorkflowRun(fx);
      const outcome = await runWorkflowToCompletion(runId);
      lines.push(
        `[run] status=${outcome.status} turns=${outcome.turns.toString()} tokens=${(outcome.usage?.totalTokens ?? 0).toString()} cached=${(outcome.usage?.cachedInputTokens ?? 0).toString()}`,
      );

      if (outcome.status === "failed") {
        failures.push(`run: le run a échoué — ${outcome.detail}`);
      }
      if (outcome.status === "turn_limit") {
        // Non-convergence IS the incident. A run that keeps answering
        // `continue` forever is what spent 42 minutes producing nothing.
        failures.push(`run: ${outcome.detail}`);
      }
      if (outcome.turns < 2) {
        failures.push(
          "run: un seul tour — la fixture n'a pas chargé assez de contexte pour mesurer quoi que ce soit",
        );
      }

      const total = outcome.usage?.totalTokens ?? 0;
      if (total === 0) {
        // `addUsage` added zeroes on an abandoned turn until 2026-09-17, so a
        // zero here is a live regression of the odometer, not a quiet run.
        failures.push(
          "usage: le compteur du run est à zéro — aucun tour n'a été compté",
        );
      }

      const output = await assistantTextFor(conversationId);
      lines.push(`[output]\n${output.slice(-2_000) || "NONE"}`);
      if (!has(output, HEAVY_WORKFLOW_TOKEN)) {
        failures.push(
          `boundary: le code d'audit ${HEAVY_WORKFLOW_TOKEN}, donné à la première tâche, n'a pas survécu à la traversée du plafond`,
        );
      }
      return { text: lines.join("\n\n"), failures };
    },
  },
];
