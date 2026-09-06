/**
 * Run the chatbot eval as a Langfuse experiment (dataset run).
 *
 * Two paths, both validated against the SDK:
 * - `includeModelGate: true` (gate runs / `--all`) → `dataset.runExperiment(...)`,
 *   the guaranteed dataset-run path (every curated item, comparable over time).
 * - Everything else → `experiment.run({ data })` with filtered hosted
 *   dataset items: the default full baseline = CORE tier only (model-gate
 *   probes excluded); `--smoke` / `--capability` select explicitly across
 *   both tiers.
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
  /** Run only one suite (`metadata.suite`, e.g. "doctrine"). */
  suite?: string;
  /**
   * Run only these case ids. Narrows whatever the other filters selected —
   * an A/B pays for every arm, so it buys the cases that discriminate rather
   * than the whole suite.
   */
  caseIds?: string[];
  /**
   * Include `tier: "model-gate"` items (per-model probes). Default
   * false: the everyday full baseline runs CORE cases only — model
   * probes measure the model, not the prompt/tool prose, and they are
   * the slow half of the suite (long-context, media fixtures, per-tool
   * micro-probes). `evals:gate` and `--all` set this to true. Ignored
   * when `smoke` or `capability` is set (explicit selections span both
   * tiers).
   */
  includeModelGate?: boolean;
  /** Skip the judge (PR tier — deterministic checks only). */
  deterministicOnly?: boolean;
  /**
   * Pin every turn to this registry profile (C3 gate candidate runs).
   * Folded into the run metadata so the Langfuse run records which
   * model served it.
   */
  candidateProfileKey?: string;
  /**
   * Pin the PAGE BUILDER to this registry profile. Distinct from
   * `candidateProfileKey`, which reaches the parent turn only — the builder is
   * a different agent on a different binding, and pinning just the parent is
   * what made every page measurement before 2026-08-18 measure the code
   * default. Recorded in the run metadata so a run says which model WROTE its
   * pages, not just which one decided to.
   */
  pageBuildProfileKey?: string;
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

/**
 * Exact agent cost of a turn = the sum of its observations' cost.
 *
 * Langfuse v4 has no trace entity (a trace IS its root observation) and
 * `GET /api/public/traces/:id` is gone, so the cost is summed over the
 * trace's observations (v2 API, `usage` field group). Returns `null` when
 * nothing is ingested yet, so the caller's retry sees a miss rather than a
 * fake 0.
 */
const fetchTraceCost = async (traceId: string): Promise<number | null> => {
  if (!langfuseClient) return null;
  try {
    let total = 0;
    let seen = 0;
    let cursor: string | undefined;
    do {
      // Cursor pagination is serial by definition: the next page key comes
      // from this response.
      // eslint-disable-next-line no-await-in-loop
      const page = await langfuseClient.api.observations.getMany({
        traceId,
        fields: "usage",
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const obs of page.data) {
        seen++;
        total += obs.totalCost ?? 0;
      }
      cursor = page.meta.cursor;
    } while (cursor !== undefined);
    return seen > 0 ? total : null;
  } catch {
    return null;
  }
};

/**
 * Run-level cost, from the server's own ledger, with Langfuse as the check.
 *
 * Each turn now reports what it spent over SSE (`TaskOutput.spend`), counted
 * by the process that spent it. The Langfuse sum is still fetched — it
 * ingests asynchronously, hence the wait and one retry — but only to be
 * compared: when the two disagree by more than 5% the run says so, because
 * the failure that made this necessary was invisible from inside Langfuse.
 *
 * The in-process judge cost is still NOT included (constant across
 * agent-model comparisons; a follow-up).
 */
const buildCostRunEvaluator = (): RunEvaluator => {
  return async ({ itemResults }) => {
    const traceIds: string[] = [];
    /** What the SERVER says each turn cost, when it said anything. */
    const served: number[] = [];
    /** Per page build, from the page-builder's own bucket. */
    const perPage: number[] = [];
    for (const r of itemResults) {
      const out: TaskOutput = r.output;
      if (out.traceId) traceIds.push(out.traceId);
      if (out.spend !== undefined) {
        served.push(out.spend.costUsd);
        const builder = out.spend.byAgent?.["chatbot.page-builder"];
        if (builder !== undefined && builder.steps > 0) {
          perPage.push(builder.costUsd);
        }
      }
    }
    if (traceIds.length === 0 && served.length === 0) return [];
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
    const langfuseTotal = have.reduce((a, b) => a + b, 0);
    const servedTotal = served.reduce((a, b) => a + b, 0);
    /**
     * The server's own ledger is the figure, and Langfuse is the check.
     *
     * Not a preference for first-party numbers on principle: summing a
     * trace's observations reported $129.50 for $5.89 of traffic on
     * 2026-09-05, because a hot-reloaded process had registered the
     * telemetry integration 22 times (`src/lib/langfuse-registration.ts`).
     * A run that reads only the pipeline cannot notice the pipeline is wrong.
     */
    const usingServer = served.length > 0;
    const total = usingServer ? servedTotal : langfuseTotal;
    const counted = usingServer ? served.length : have.length;
    const perTurn = counted > 0 ? total / counted : 0;
    const evaluations: Evaluation[] = [
      {
        name: "cost-agent-usd",
        value: Number(total.toFixed(6)),
        dataType: "NUMERIC",
        comment: usingServer
          ? `${served.length}/${itemResults.length} turns costed by the server`
          : `${have.length}/${traceIds.length} turns costed from Langfuse (server ledger absent — old service?)`,
      },
      {
        name: "cost-per-turn-usd",
        value: Number(perTurn.toFixed(6)),
        dataType: "NUMERIC",
      },
    ];
    if (perPage.length > 0) {
      evaluations.push({
        name: "cost-per-page-usd",
        value: Number(
          (perPage.reduce((a, b) => a + b, 0) / perPage.length).toFixed(6),
        ),
        dataType: "NUMERIC",
        comment: `${perPage.length} page build(s)`,
      });
    }
    // The disagreement is the point. A drift above a few percent means one of
    // the two is counting something the other cannot see — most likely an
    // observation fan-out, which is invisible from inside Langfuse.
    if (usingServer && have.length > 0 && servedTotal > 0) {
      const drift = (langfuseTotal - servedTotal) / servedTotal;
      if (Math.abs(drift) > 0.05) {
        console.warn(
          `[evals] cost drift: Langfuse says $${langfuseTotal.toFixed(4)}, the server counted $${servedTotal.toFixed(4)} (${(drift * 100).toFixed(0)}%). Check the service's boot line for \`integrations=\` — anything but 1 multiplies every observation.`,
        );
      }
      evaluations.push({
        name: "cost-langfuse-drift",
        value: Number(drift.toFixed(4)),
        dataType: "NUMERIC",
        comment: `langfuse $${langfuseTotal.toFixed(4)} vs server $${servedTotal.toFixed(4)}`,
      });
    }
    return evaluations;
  };
};

const readMeta = (item: {
  metadata?: unknown;
}): {
  smoke?: boolean;
  capability?: string;
  tier?: string;
  suite?: string;
  caseId?: string;
} => {
  const m = item.metadata;
  if (!m || typeof m !== "object") return {};
  const smoke =
    "smoke" in m && typeof m.smoke === "boolean" ? m.smoke : undefined;
  const capability =
    "capability" in m && typeof m.capability === "string"
      ? m.capability
      : undefined;
  const tier = "tier" in m && typeof m.tier === "string" ? m.tier : undefined;
  const suite =
    "suite" in m && typeof m.suite === "string" ? m.suite : undefined;
  const caseId =
    "caseId" in m && typeof m.caseId === "string" ? m.caseId : undefined;
  return { smoke, capability, tier, suite, caseId };
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
    modelProfileKey: opts.candidateProfileKey,
    pageBuildProfileKey: opts.pageBuildProfileKey,
  });
  const evaluators = [buildItemEvaluator(configIds)];
  const runEvaluators = [buildRunEvaluator(configIds), buildCostRunEvaluator()];
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const caseIds =
    opts.caseIds && opts.caseIds.length > 0 ? opts.caseIds : undefined;
  const explicitSelection = Boolean(
    opts.smoke || opts.capability || opts.suite || caseIds,
  );
  // Default full run = CORE tier only; `includeModelGate` (gate / --all)
  // restores the true unfiltered dataset run.
  const filtered = explicitSelection || opts.includeModelGate !== true;
  const dataset = await langfuseClient.dataset.get(DATASET_NAME);

  const metadata = {
    ...(opts.metadata ?? {}),
    ...(opts.candidateProfileKey
      ? { candidateProfileKey: opts.candidateProfileKey }
      : {}),
    ...(opts.pageBuildProfileKey
      ? { pageBuildProfileKey: opts.pageBuildProfileKey }
      : {}),
  };
  const common = {
    name: EXPERIMENT_NAME,
    ...(opts.runName ? { runName: opts.runName } : {}),
    task,
    evaluators,
    runEvaluators,
    maxConcurrency,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  let result: ExperimentResult;
  if (!filtered) {
    result = await dataset.runExperiment(common);
  } else {
    const data = dataset.items.filter((item) => {
      const meta = readMeta(item);
      if (opts.smoke && meta.smoke !== true) return false;
      if (opts.capability && meta.capability !== opts.capability) return false;
      if (opts.suite && meta.suite !== opts.suite) return false;
      if (caseIds && !(meta.caseId && caseIds.includes(meta.caseId)))
        return false;
      // Core-only default: skip model-gate probes unless the caller
      // selected explicitly (smoke / capability span both tiers).
      if (!explicitSelection && meta.tier === "model-gate") return false;
      return true;
    });
    // A `--case` that matches nothing is a typo, and an arm that quietly runs
    // fewer cases than its twin is not comparable to it. Stop rather than
    // produce a run whose `N items` has to be noticed.
    if (caseIds) {
      const matched = new Set(
        data.map((item) => readMeta(item).caseId).filter(Boolean),
      );
      const missing = caseIds.filter((id) => !matched.has(id));
      if (missing.length > 0) {
        throw new Error(
          `no dataset item for case id(s): ${missing.join(", ")} — check the id, or sync the dataset (bun evals/langfuse/dataset-sync.ts)`,
        );
      }
    }
    result = await langfuseClient.experiment.run({ ...common, data });
  }

  // The SDK still links dataset-run items over the v3 endpoint, which a v4
  // server no longer serves: `datasetRunId` comes back undefined and the
  // ExperimentManager then SKIPS persisting the run-level evaluations. The
  // experiment itself exists — its id rode in on the OTel experiment
  // attributes and is returned as `experimentId` — so attach the run scores
  // to it here. A score's `datasetRunId` IS the experiment id in v4
  // vocabulary (scores v3 filters those with `experimentId`). Guarded: when
  // the SDK did link the run, it already wrote them.
  if (result.datasetRunId === undefined) {
    for (const evaluation of result.runEvaluations) {
      langfuseClient.score.create({
        datasetRunId: result.experimentId,
        ...evaluation,
      });
    }
    await langfuseClient.score.flush();
  }

  await flushLangfuse();
  return result;
};
