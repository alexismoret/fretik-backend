/**
 * Eval gates. Two modes, one file:
 *
 * 1. LEGACY smoke threshold (no `--candidate`): run the smoke subset,
 *    fail when run-level `correctness` drops under
 *    `EVAL_CORRECTNESS_THRESHOLD` (default 0.6). Unchanged behaviour;
 *    `experiment(context)` is kept for any future node-based
 *    `langfuse/experiment-action` use.
 *
 * 2. MODEL-PROMOTION gate (C3): `--candidate <profileKey>` runs the
 *    curated suite twice BACK-TO-BACK — baseline (current `chat`
 *    binding) then candidate, both pinned via `X-Model-Profile-Key` —
 *    and compares them on paired same-data/same-day runs, reading
 *    scores IN-PROCESS (no ingestion wait). `--baseline-run <name>`
 *    reuses a stored Langfuse dataset run instead, after a PARITY
 *    CHECK (same caseId set as the current curated set — a 21-case
 *    baseline is meaningless against a 46-case candidate).
 *
 *    Criteria (envelopes in `gate-config.ts`): per-capability
 *    correctness drop ≤ 1 case-equivalent; tool-call-validity ≥
 *    baseline − ε; zombie-rate ≤ baseline + ε; cost-per-turn within
 *    the profile's costClass envelope (ADVISORY until calibrated);
 *    avg latency ≤ 1.5× baseline; fallback-served items ≤ 1. Plus a
 *    tool-calling EFFICIENCY section (avg-tool-calls / tool-error-rate
 *    / redundant-call-rate) — ADVISORY in C11, never failing.
 *
 *    Output: a verdict per criterion + SUGGESTED A/B/C grades and an
 *    `evalGate` stamp. The gate NEVER writes `profiles.ts` — a human
 *    commits the grades in a reviewed PR; the PR is the promotion.
 *
 * Needs a LIVE @fretik/ai at `AI_SERVICE_URL` (see `evals/RUNBOOK.md`).
 *
 *   bun run evals:gate -- --candidate minimax-m3 [--baseline-run <name>]
 *   bun run evals:gate -- --candidate minimax-m2.7        # self-test
 */

import { RegressionError, type RunnerContext } from "@langfuse/client";
import { langfuseClient } from "../../src/lib/langfuse";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../src/lib/model-registry/profiles";
import { CURATED } from "../curation";
import { CAPABILITIES, type Capability } from "../types";
import { DATASET_NAME } from "./dataset-sync";
import { caseCorrectness, isZombie } from "./evaluators";
import { runChatbotExperiment } from "./experiment";
import {
  GATE_CONFIG,
  IF_GRADE_THRESHOLDS,
  SO_GRADE_THRESHOLDS,
  TOOL_GRADE_THRESHOLDS,
} from "./gate-config";
import { buildCaseRegistry } from "./task";
import type { TaskOutput } from "./types";

const THRESHOLD = Number(process.env.EVAL_CORRECTNESS_THRESHOLD ?? "0.6");

// ───────────────────────── legacy smoke gate ─────────────────────────

const runGate = async () => {
  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  const result = await runChatbotExperiment({
    smoke: true,
    deterministicOnly: false,
    ...(sha ? { runName: `pr-${sha}` } : {}),
    metadata: { tier: "pr-smoke" },
  });
  const correctness = result.runEvaluations.find(
    (e) => e.name === "correctness",
  )?.value;
  if (typeof correctness !== "number" || correctness < THRESHOLD) {
    throw new RegressionError({
      result,
      metric: "correctness",
      value: typeof correctness === "number" ? correctness : 0,
      threshold: THRESHOLD,
    });
  }
  return result;
};

/** Kept for future `langfuse/experiment-action` use (node-based). */
export const experiment = async (_context: RunnerContext) => runGate();

// ──────────────────────── model-promotion gate ───────────────────────

interface CapabilityMetric {
  value: number;
  cases: number;
}

/** Comparable metric snapshot of one run (live or stored). */
interface RunMetrics {
  source: "live" | "stored";
  runName: string;
  datasetRunId?: string;
  correctness?: number;
  perCapability: Partial<Record<Capability, CapabilityMetric>>;
  toolCallValidity?: number;
  zombieRate?: number;
  avgLatencyMs?: number;
  costPerTurnUsd?: number;
  fallbackServedCount: number;
  // C11 tool-calling efficiency (advisory). errorThenRetryTotal is only
  // available from a live run (not a seeded score → absent for stored).
  avgToolCalls?: number;
  toolErrorRate?: number;
  redundantCallRate?: number;
  errorThenRetryTotal?: number;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

type GateExperimentResult = Awaited<ReturnType<typeof runChatbotExperiment>>;

const outputsOf = (result: GateExperimentResult): TaskOutput[] =>
  result.itemResults.map((r) => r.output);

/** Metrics of a run this process just executed — computed from itemResults. */
const metricsFromResult = (
  result: GateExperimentResult,
  runName: string,
): RunMetrics => {
  const outputs = outputsOf(result);
  const perCapability: Partial<Record<Capability, CapabilityMetric>> = {};
  for (const cap of CAPABILITIES) {
    const subset = outputs.filter((o) => o.capability === cap);
    if (subset.length === 0) continue;
    perCapability[cap] = {
      value: mean(subset.map(caseCorrectness)),
      cases: subset.length,
    };
  }
  const totals = outputs.reduce(
    (acc, o) => {
      if (o.toolCallValidity) {
        acc.valid += o.toolCallValidity.valid;
        acc.total += o.toolCallValidity.total;
      }
      return acc;
    },
    { valid: 0, total: 0 },
  );
  const cost = result.runEvaluations.find(
    (e) => e.name === "cost-per-turn-usd",
  )?.value;
  const eff = outputs.reduce(
    (acc, o) => {
      if (o.toolEfficiency) {
        acc.cases++;
        acc.calls += o.toolEfficiency.totalCalls;
        acc.errors += o.toolEfficiency.errorCalls;
        acc.errorThenRetry += o.toolEfficiency.errorThenRetry;
        if (o.toolEfficiency.redundantCalls > 0) acc.redundantCases++;
      }
      return acc;
    },
    { cases: 0, calls: 0, errors: 0, errorThenRetry: 0, redundantCases: 0 },
  );
  return {
    source: "live",
    runName,
    ...(result.datasetRunId !== undefined
      ? { datasetRunId: result.datasetRunId }
      : {}),
    correctness: mean(outputs.map(caseCorrectness)),
    perCapability,
    ...(totals.total > 0
      ? { toolCallValidity: totals.valid / totals.total }
      : {}),
    zombieRate: mean(outputs.map((o) => (isZombie(o) ? 1 : 0))),
    avgLatencyMs: mean(outputs.map((o) => o.latencyMs)),
    ...(typeof cost === "number" ? { costPerTurnUsd: cost } : {}),
    fallbackServedCount: outputs.filter((o) => o.fallbackServed === true)
      .length,
    ...(eff.cases > 0
      ? {
          avgToolCalls: eff.calls / eff.cases,
          redundantCallRate: eff.redundantCases / eff.cases,
          errorThenRetryTotal: eff.errorThenRetry,
        }
      : {}),
    ...(eff.calls > 0 ? { toolErrorRate: eff.errors / eff.calls } : {}),
  };
};

/**
 * Metrics of a STORED dataset run, via the Langfuse API. Parity-checks
 * the run's caseId set against the CURRENT curated set first — scores
 * from a differently-sized dataset are not comparable.
 */
const metricsFromStoredRun = async (runName: string): Promise<RunMetrics> => {
  if (!langfuseClient) {
    throw new Error("Langfuse not configured (LANGFUSE_* env missing)");
  }
  const run = await langfuseClient.api.datasets.getRun(DATASET_NAME, runName);

  // Parity check: map the run's datasetItemIds back to caseIds and
  // compare against the current curated set.
  const dataset = await langfuseClient.dataset.get(DATASET_NAME);
  const caseIdByItemId = new Map<string, string>();
  for (const item of dataset.items) {
    const meta: unknown = item.metadata;
    if (meta && typeof meta === "object" && "caseId" in meta) {
      const caseId = meta.caseId;
      if (typeof caseId === "string") caseIdByItemId.set(item.id, caseId);
    }
  }
  const runCaseIds = new Set(
    run.datasetRunItems
      .map((i) => caseIdByItemId.get(i.datasetItemId))
      .filter((id): id is string => typeof id === "string"),
  );
  const curatedIds = new Set(Object.keys(CURATED));
  const missing = [...curatedIds].filter((id) => !runCaseIds.has(id));
  const extra = [...runCaseIds].filter((id) => !curatedIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `baseline run "${runName}" is not comparable to the current curated set ` +
        `(missing: ${missing.length.toString()}, extra: ${extra.length.toString()}). ` +
        `Run the gate without --baseline-run for a paired back-to-back comparison.`,
    );
  }

  // Run-level scores (the ones runEvaluators attached to this run).
  const scores = await langfuseClient.api.scores.getMany({
    datasetRunId: run.id,
    limit: 100,
  });
  const byName = new Map<string, { value: number; comment?: string }>();
  for (const s of scores.data) {
    if (!("value" in s) || typeof s.value !== "number") continue;
    // First write wins per name — if item-level scores leak into this
    // query they share names with run scores; the run evaluator wrote
    // last, and the API returns newest first, so keep the first.
    if (!byName.has(s.name)) {
      byName.set(s.name, {
        value: s.value,
        ...(typeof s.comment === "string" ? { comment: s.comment } : {}),
      });
    }
  }
  const get = (name: string): number | undefined => byName.get(name)?.value;
  const perCapability: Partial<Record<Capability, CapabilityMetric>> = {};
  for (const cap of CAPABILITIES) {
    const entry = byName.get(`correctness:${cap}`);
    if (!entry) continue;
    const counted = /^(\d+) cases$/.exec(entry.comment ?? "");
    perCapability[cap] = {
      value: entry.value,
      cases: counted?.[1] !== undefined ? Number(counted[1]) : 0,
    };
  }
  const correctness = get("correctness");
  const validity = get("tool-call-validity");
  const zombieRate = get("zombie-rate");
  const avgLatencyMs = get("avg-latency-ms");
  const cost = get("cost-per-turn-usd");
  const avgToolCalls = get("avg-tool-calls");
  const toolErrorRate = get("tool-error-rate");
  const redundantCallRate = get("redundant-call-rate");
  return {
    source: "stored",
    runName,
    datasetRunId: run.id,
    ...(correctness !== undefined ? { correctness } : {}),
    perCapability,
    ...(validity !== undefined ? { toolCallValidity: validity } : {}),
    ...(zombieRate !== undefined ? { zombieRate } : {}),
    ...(avgLatencyMs !== undefined ? { avgLatencyMs } : {}),
    ...(cost !== undefined ? { costPerTurnUsd: cost } : {}),
    fallbackServedCount: get("fallback-served-count") ?? 0,
    ...(avgToolCalls !== undefined ? { avgToolCalls } : {}),
    ...(toolErrorRate !== undefined ? { toolErrorRate } : {}),
    ...(redundantCallRate !== undefined ? { redundantCallRate } : {}),
  };
};

interface CriterionResult {
  name: string;
  verdict: "pass" | "fail" | "advisory" | "skipped";
  detail: string;
}

const evaluateCriteria = (
  base: RunMetrics,
  cand: RunMetrics,
  candidateKey: string,
): CriterionResult[] => {
  const cfg = GATE_CONFIG;
  const out: CriterionResult[] = [];

  for (const cap of CAPABILITIES) {
    const b = base.perCapability[cap];
    const c = cand.perCapability[cap];
    if (!b || !c) continue;
    const dropCases = (b.value - c.value) * c.cases;
    out.push({
      name: `correctness:${cap}`,
      verdict: dropCases <= cfg.maxCapabilityDropCases + 1e-9 ? "pass" : "fail",
      detail: `${b.value.toFixed(3)} → ${c.value.toFixed(3)} (${dropCases <= 0 ? "no drop" : `${dropCases.toFixed(2)} case-equivalents lost`}, max ${cfg.maxCapabilityDropCases.toString()})`,
    });
  }

  if (
    base.toolCallValidity !== undefined &&
    cand.toolCallValidity !== undefined
  ) {
    out.push({
      name: "tool-call-validity",
      verdict:
        cand.toolCallValidity >= base.toolCallValidity - cfg.epsilon
          ? "pass"
          : "fail",
      detail: `${base.toolCallValidity.toFixed(3)} → ${cand.toolCallValidity.toFixed(3)} (ε=${cfg.epsilon.toString()})`,
    });
  } else {
    out.push({
      name: "tool-call-validity",
      verdict: "skipped",
      detail: "metric missing on one side",
    });
  }

  if (base.zombieRate !== undefined && cand.zombieRate !== undefined) {
    out.push({
      name: "zombie-rate",
      verdict:
        cand.zombieRate <= base.zombieRate + cfg.epsilon ? "pass" : "fail",
      detail: `${base.zombieRate.toFixed(3)} → ${cand.zombieRate.toFixed(3)} (ε=${cfg.epsilon.toString()})`,
    });
  }

  const profile = MODEL_PROFILES[candidateKey];
  if (profile && cand.costPerTurnUsd !== undefined) {
    const envelope =
      GATE_CONFIG.costEnvelopeUsdPerTurn[profile.assessment.costClass];
    const within = cand.costPerTurnUsd <= envelope;
    out.push({
      name: "cost-per-turn-usd",
      verdict: cfg.costCalibrated ? (within ? "pass" : "fail") : "advisory",
      detail: `$${cand.costPerTurnUsd.toFixed(4)}/turn vs ${profile.assessment.costClass} envelope $${envelope.toString()}${cfg.costCalibrated ? "" : " — UNCALIBRATED, advisory only (see gate-config.ts)"}`,
    });
  }

  if (base.avgLatencyMs !== undefined && cand.avgLatencyMs !== undefined) {
    const cap = cfg.latencyFactor * base.avgLatencyMs;
    out.push({
      name: "avg-latency-ms",
      verdict: cand.avgLatencyMs <= cap ? "pass" : "fail",
      detail: `${Math.round(base.avgLatencyMs).toString()}ms → ${Math.round(cand.avgLatencyMs).toString()}ms (cap ${Math.round(cap).toString()}ms = ${cfg.latencyFactor.toString()}×)`,
    });
  }

  out.push({
    name: "fallback-served",
    verdict:
      cand.fallbackServedCount <= cfg.maxFallbackServed ? "pass" : "fail",
    detail: `${cand.fallbackServedCount.toString()} candidate case(s) answered by the fallback agent (max ${cfg.maxFallbackServed.toString()})`,
  });

  // ── C11 tool-calling EFFICIENCY (advisory until calibrated) ──────────
  // ADVISORY by default: reported, never failing. A reviewed flip of
  // `efficiencyEnforced` (after a baseline sets real envelopes) turns
  // these into pass/fail — same discipline as the cost criterion.
  const env = cfg.efficiencyEnvelope;
  const note = cfg.efficiencyEnforced ? "" : " — advisory (uncalibrated)";
  const effVerdict = (within: boolean): CriterionResult["verdict"] =>
    cfg.efficiencyEnforced ? (within ? "pass" : "fail") : "advisory";

  if (base.avgToolCalls !== undefined && cand.avgToolCalls !== undefined) {
    const capCalls = env.avgToolCallsFactor * base.avgToolCalls;
    out.push({
      name: "avg-tool-calls",
      verdict: effVerdict(cand.avgToolCalls <= capCalls + 1e-9),
      detail: `${base.avgToolCalls.toFixed(2)} → ${cand.avgToolCalls.toFixed(2)} (cap ${capCalls.toFixed(2)} = ${env.avgToolCallsFactor.toString()}×)${note}`,
    });
  }
  if (cand.toolErrorRate !== undefined) {
    out.push({
      name: "tool-error-rate",
      verdict: effVerdict(cand.toolErrorRate <= env.maxToolErrorRate),
      detail: `${(base.toolErrorRate ?? 0).toFixed(3)} → ${cand.toolErrorRate.toFixed(3)} (max ${env.maxToolErrorRate.toString()})${cand.errorThenRetryTotal !== undefined ? `, ${cand.errorThenRetryTotal.toString()} error→retry` : ""}${note}`,
    });
  }
  if (cand.redundantCallRate !== undefined) {
    out.push({
      name: "redundant-call-rate",
      verdict: effVerdict(cand.redundantCallRate <= env.maxRedundantCallRate),
      detail: `${(base.redundantCallRate ?? 0).toFixed(3)} → ${cand.redundantCallRate.toFixed(3)} (max ${env.maxRedundantCallRate.toString()})${note}`,
    });
  }

  return out;
};

const gradeFor = (
  ratio: number,
  thresholds: { a: number; b: number },
): "A" | "B" | "C" =>
  ratio >= thresholds.a ? "A" : ratio >= thresholds.b ? "B" : "C";

/** Suggested `profiles.ts` updates — computed, never written. */
const printSuggestions = (
  cand: RunMetrics,
  result: GateExperimentResult,
  candidateKey: string,
  passed: boolean,
): void => {
  const registry = buildCaseRegistry();
  const outputs = outputsOf(result);
  const tagged = (tag: string): TaskOutput[] =>
    outputs.filter((o) => registry.get(o.caseId)?.case.tags?.includes(tag));

  console.log(`\nSuggested profiles.ts updates for "${candidateKey}":`);
  if (cand.toolCallValidity !== undefined) {
    console.log(
      `  toolCalling.grade: "${gradeFor(cand.toolCallValidity, TOOL_GRADE_THRESHOLDS)}"  (tool-call-validity ${cand.toolCallValidity.toFixed(3)})`,
    );
  }
  const ifMetric = cand.perCapability["instruction-following"];
  if (ifMetric) {
    console.log(
      `  instructionFollowing: "${gradeFor(ifMetric.value, IF_GRADE_THRESHOLDS)}"  (correctness:instruction-following ${ifMetric.value.toFixed(3)} over ${ifMetric.cases.toString()} cases)`,
    );
  }
  const soOutputs = tagged("structured-output");
  if (soOutputs.length > 0) {
    const soScore = mean(soOutputs.map(caseCorrectness));
    console.log(
      `  structuredOutput.grade: "${gradeFor(soScore, SO_GRADE_THRESHOLDS)}"  (${soOutputs.length.toString()} structured-output probes, ${soScore.toFixed(3)})`,
    );
  }
  const parOutputs = tagged("parallel");
  if (parOutputs.length > 0) {
    const observed = parOutputs.filter(
      (o) => o.parallelObserved === true,
    ).length;
    const suggestion =
      observed >= 2
        ? '"supported"'
        : observed === 1
          ? '"supported" (1/3 only — verify provider-pool behaviour first)'
          : '"unsupported" (no probe batched — or keep current value)';
    console.log(
      `  toolCalling.parallel: ${suggestion}  (${observed.toString()}/${parOutputs.length.toString()} parallel probes batched)`,
    );
  }
  const gatedAt = new Date().toISOString().slice(0, 10);
  console.log(
    `  evalGate: { status: "${passed ? "passed" : "failed"}", lastRunId: "${cand.datasetRunId ?? "?"}", gatedAt: "${gatedAt}" },`,
  );
  console.log(
    "\nThe gate never writes profiles.ts — commit these in a reviewed PR (the PR IS the promotion).",
  );
};

interface ModelGateOptions {
  candidate: string;
  baselineRun?: string;
  smoke: boolean;
  concurrency?: number;
}

const runModelGate = async (opts: ModelGateOptions): Promise<void> => {
  if (!MODEL_PROFILES[opts.candidate]) {
    throw new Error(
      `Unknown candidate profile key "${opts.candidate}". Known keys: ${Object.keys(MODEL_PROFILES).join(", ")}`,
    );
  }
  const baselineKey = ROLE_BINDINGS.chat.profileKey;
  // Minute-precision stamp: a same-day relaunch (crash, network cut)
  // must NOT append into the interrupted run's dataset-run name.
  const stamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, "")
    .replace("T", "-");

  let baseMetrics: RunMetrics;
  if (opts.baselineRun !== undefined) {
    console.log(`[gate] reusing stored baseline run "${opts.baselineRun}"`);
    baseMetrics = await metricsFromStoredRun(opts.baselineRun);
  } else {
    const baseRunName = `gate-base-${baselineKey}-${stamp}`;
    console.log(
      `[gate] baseline run (${baselineKey}) — ${baseRunName}${opts.smoke ? " [smoke]" : ""}`,
    );
    const baseResult = await runChatbotExperiment({
      smoke: opts.smoke,
      candidateProfileKey: baselineKey,
      runName: baseRunName,
      ...(opts.concurrency !== undefined
        ? { maxConcurrency: opts.concurrency }
        : {}),
      metadata: {
        tier: "model-gate",
        role: "baseline",
        baselineProfileKey: baselineKey,
        gateCandidateProfileKey: opts.candidate,
      },
    });
    baseMetrics = metricsFromResult(baseResult, baseRunName);
  }

  const candRunName = `gate-cand-${opts.candidate}-${stamp}`;
  console.log(
    `[gate] candidate run (${opts.candidate}) — ${candRunName}${opts.smoke ? " [smoke]" : ""}`,
  );
  const candResult = await runChatbotExperiment({
    smoke: opts.smoke,
    candidateProfileKey: opts.candidate,
    runName: candRunName,
    ...(opts.concurrency !== undefined
      ? { maxConcurrency: opts.concurrency }
      : {}),
    metadata: {
      tier: "model-gate",
      role: "candidate",
      baselineProfileKey: baselineKey,
    },
  });
  const candMetrics = metricsFromResult(candResult, candRunName);

  const criteria = evaluateCriteria(baseMetrics, candMetrics, opts.candidate);
  console.log(
    `\n[gate] ${baselineKey} (baseline${baseMetrics.source === "stored" ? ", stored" : ""}) vs ${opts.candidate} (candidate)\n`,
  );
  for (const c of criteria) {
    const mark =
      c.verdict === "pass"
        ? "✓"
        : c.verdict === "fail"
          ? "✗"
          : c.verdict === "advisory"
            ? "≈"
            : "·";
    console.log(`  ${mark} ${c.name.padEnd(36)} ${c.detail}`);
  }
  const failed = criteria.filter((c) => c.verdict === "fail");
  const passed = failed.length === 0;
  printSuggestions(candMetrics, candResult, opts.candidate, passed);

  if (!passed) {
    const first = failed[0];
    throw new RegressionError({
      result: candResult,
      metric: first?.name ?? "gate",
      value: 0,
      threshold: 1,
    });
  }
  console.log(
    `\n[gate] PASS — ${failed.length.toString()} failing criteria. Candidate run: ${candResult.datasetRunUrl ?? candMetrics.datasetRunId ?? candRunName}`,
  );
};

// ───────────────────────────── CLI entry ─────────────────────────────

interface GateCliOptions {
  candidate?: string;
  baselineRun?: string;
  smoke: boolean;
  concurrency?: number;
}

const parseGateArgs = (argv: string[]): GateCliOptions => {
  const opts: GateCliOptions = { smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--candidate" && next) {
      opts.candidate = next;
      i++;
    } else if (flag === "--baseline-run" && next) {
      opts.baselineRun = next;
      i++;
    } else if (flag === "--smoke") {
      opts.smoke = true;
    } else if (flag === "--concurrency" && next) {
      const n = parseInt(next, 10);
      if (!Number.isNaN(n) && n > 0) opts.concurrency = n;
      i++;
    }
  }
  return opts;
};

if (import.meta.main) {
  const opts = parseGateArgs(process.argv.slice(2));
  const entry =
    opts.candidate !== undefined
      ? runModelGate({
          candidate: opts.candidate,
          ...(opts.baselineRun !== undefined
            ? { baselineRun: opts.baselineRun }
            : {}),
          smoke: opts.smoke,
          ...(opts.concurrency !== undefined
            ? { concurrency: opts.concurrency }
            : {}),
        })
      : runGate();
  entry
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      if (err instanceof RegressionError) {
        console.error(`[gate] regression: ${err.message}`);
      } else {
        console.error("[gate] fatal:", err);
      }
      process.exit(1);
    });
}
