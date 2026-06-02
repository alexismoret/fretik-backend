/**
 * Run the chatbot eval as a Langfuse experiment (dataset run).
 *
 * Two paths, both validated against the SDK:
 * - No filter (the nightly BASELINE) → `dataset.runExperiment(...)`, the
 *   guaranteed dataset-run path (all curated items, comparable over time).
 * - Filtered (PR smoke set or one capability) → `experiment.run({ data })`
 *   with the filtered hosted dataset items.
 *
 * The judge runs in-process (the authoritative loop judge); the managed
 * online evaluator is separate (production traces). Scores link to their
 * configs via `configId` (`fetchConfigIds`).
 */

import type {
  Evaluation,
  ExperimentResult,
  RunEvaluator,
} from "@langfuse/client";
import { flushLangfuse, langfuseClient } from "../../src/lib/langfuse";
import type { Capability } from "../types";
import { DATASET_NAME } from "./dataset-sync";
import {
  buildItemEvaluator,
  buildRunEvaluator,
  type ConfigIds,
} from "./evaluators";
import { buildExperimentTask } from "./task";
import type { TaskOutput } from "./types";

export interface ExperimentOptions {
  /** Run only the PR smoke subset (`metadata.smoke`). */
  smoke?: boolean;
  /** Run only one capability stratum. */
  capability?: Capability;
  /** Skip the judge (PR tier — deterministic checks only). */
  deterministicOnly?: boolean;
  runName?: string;
  /** Concurrent cases — keep low; each is a real chatbot turn. */
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
}

const EXPERIMENT_NAME = "chatbot-eval";
const DEFAULT_CONCURRENCY = 3;

/** name → score-config id, so evaluator scores link to their config. */
export const fetchConfigIds = async (): Promise<ConfigIds> => {
  if (!langfuseClient) return {};
  const ids: ConfigIds = {};
  const res = await langfuseClient.api.scoreConfigs.get({ limit: 100 });
  for (const cfg of res.data) ids[cfg.name] = cfg.id;
  return ids;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exact agent cost of a turn = its server `chatbot-turn` trace totalCost. */
const fetchTraceCost = async (traceId: string): Promise<number | null> => {
  if (!langfuseClient) return null;
  try {
    const trace = await langfuseClient.api.trace.get(traceId);
    return typeof trace.totalCost === "number" ? trace.totalCost : null;
  } catch {
    return null;
  }
};

/**
 * Run-level cost: sum each turn's agent cost (the server `chatbot-turn`
 * trace, via the captured `traceId`). Trace cost ingests asynchronously,
 * so wait then fetch with one retry for the stragglers. The in-process
 * judge cost is NOT included yet (constant across agent-model comparisons;
 * a follow-up). Lets you compare agent-model cost across runs in the UI.
 */
const buildCostRunEvaluator = (): RunEvaluator => {
  return async ({ itemResults }) => {
    const traceIds: string[] = [];
    for (const r of itemResults) {
      const out: TaskOutput = r.output;
      if (out.traceId) traceIds.push(out.traceId);
    }
    if (traceIds.length === 0) return [];
    await sleep(6000);
    let costs = await Promise.all(traceIds.map(fetchTraceCost));
    if (costs.some((c) => c === null)) {
      await sleep(5000);
      costs = await Promise.all(
        traceIds.map((id, i) => {
          const prev = costs[i];
          return prev != null ? Promise.resolve(prev) : fetchTraceCost(id);
        }),
      );
    }
    const have = costs.filter((c): c is number => typeof c === "number");
    const total = have.reduce((a, b) => a + b, 0);
    const perTurn = have.length > 0 ? total / have.length : 0;
    const evaluations: Evaluation[] = [
      {
        name: "cost-agent-usd",
        value: Number(total.toFixed(6)),
        dataType: "NUMERIC",
        comment: `${have.length}/${traceIds.length} turns costed`,
      },
      {
        name: "cost-per-turn-usd",
        value: Number(perTurn.toFixed(6)),
        dataType: "NUMERIC",
      },
    ];
    return evaluations;
  };
};

const readMeta = (item: {
  metadata?: unknown;
}): { smoke?: boolean; capability?: string } => {
  const m = item.metadata;
  if (!m || typeof m !== "object") return {};
  const smoke =
    "smoke" in m && typeof m.smoke === "boolean" ? m.smoke : undefined;
  const capability =
    "capability" in m && typeof m.capability === "string"
      ? m.capability
      : undefined;
  return { smoke, capability };
};

export const runChatbotExperiment = async (
  opts: ExperimentOptions = {},
): Promise<ExperimentResult> => {
  if (!langfuseClient) {
    throw new Error("Langfuse not configured (LANGFUSE_* env missing)");
  }
  const configIds = await fetchConfigIds();
  const task = buildExperimentTask({
    deterministicOnly: opts.deterministicOnly,
  });
  const evaluators = [buildItemEvaluator(configIds)];
  const runEvaluators = [buildRunEvaluator(configIds), buildCostRunEvaluator()];
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const filtered = Boolean(opts.smoke || opts.capability);
  const dataset = await langfuseClient.dataset.get(DATASET_NAME);

  const common = {
    name: EXPERIMENT_NAME,
    ...(opts.runName ? { runName: opts.runName } : {}),
    task,
    evaluators,
    runEvaluators,
    maxConcurrency,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };

  let result: ExperimentResult;
  if (!filtered) {
    result = await dataset.runExperiment(common);
  } else {
    const data = dataset.items.filter((item) => {
      const meta = readMeta(item);
      if (opts.smoke && meta.smoke !== true) return false;
      if (opts.capability && meta.capability !== opts.capability) return false;
      return true;
    });
    result = await langfuseClient.experiment.run({ ...common, data });
  }

  await flushLangfuse();
  return result;
};
