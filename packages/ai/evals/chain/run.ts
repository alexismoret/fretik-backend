#!/usr/bin/env bun
/**
 * Chain-eval runner — the memory pipeline scored end to end (see `cases.ts`).
 *
 * Same shape as the recall runner: N repeats per case, all-or-nothing per case,
 * explicit bimodal detection, run-level aggregates pushed to a `chain-eval`
 * dataset run. What it adds is STAGE ATTRIBUTION — every failure names the
 * stage that produced it, which is what neither existing suite can do.
 *
 *   bun run evals:chain                                  # 3 repeats
 *   bun run evals:chain -- --repeats 10 --run-name base
 *   bun run evals:chain -- --case chain-decision-survives
 *   bun run evals:chain -- --cleanup     # BEFORE any recall run
 *
 * Env (from `.env`): DATABASE_URL, OPENROUTER_API_KEY, LANGFUSE_*,
 * EVAL_TEAM_ID, EVAL_ORGANIZATION_ID, EVAL_USER_ID.
 */

import type {
  Evaluation,
  ExperimentTask,
  RunEvaluator,
} from "@langfuse/client";
import { flushLangfuse, langfuseClient } from "../../src/lib/langfuse";
import { raceDeadline } from "../deadline";
import { CHAIN_CASES, type ChainEvalCase } from "./cases";
import {
  type ChainFixtures,
  cleanupChainFixtures,
  ensureChainFixtures,
} from "./fixtures";

const DATASET_NAME = "chain-eval";
const DATASET_DESCRIPTION =
  "Memory chain eval — conversation → distill → consolidate → promote → recall, scored on the final block with per-stage attribution. Source of truth = backend/packages/ai/evals/chain.";
const DEFAULT_REPEATS = 3;

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const scope = {
  teamId: process.env.EVAL_TEAM_ID ?? "",
  organizationId: process.env.EVAL_ORGANIZATION_ID ?? "",
  userId: process.env.EVAL_USER_ID ?? "",
};
if (!scope.teamId || !scope.organizationId || !scope.userId) {
  console.error("Missing EVAL_TEAM_ID / EVAL_ORGANIZATION_ID / EVAL_USER_ID");
  process.exit(1);
}

if (flag("--cleanup")) {
  await cleanupChainFixtures(scope);
  console.log("[chain-eval] fixtures cleaned up");
  process.exit(0);
}

const repeatsRaw = Number.parseInt(opt("--repeats") ?? "", 10);
const repeats =
  Number.isFinite(repeatsRaw) && repeatsRaw > 0 ? repeatsRaw : DEFAULT_REPEATS;
const onlyCase = opt("--case");
const cases = onlyCase
  ? CHAIN_CASES.filter((c) => c.id === onlyCase)
  : CHAIN_CASES;
if (cases.length === 0) {
  console.error(`No case matches --case ${onlyCase ?? ""}`);
  process.exit(1);
}

console.log("[chain-eval] ensuring fixtures (idempotent)…");
const fixtures: ChainFixtures = await ensureChainFixtures(scope);
console.log("[chain-eval] fixtures ready");

interface RepeatOutcome {
  text: string;
  failures: string[];
  latencyMs: number;
}
interface CaseOutcome {
  caseId: string;
  passed: boolean;
  passFraction: number;
  repeats: RepeatOutcome[];
  avgLatencyMs: number;
}

/** Neither always-pass nor always-fail — the shape the all-or-nothing gate hides. */
const isBimodal = (o: CaseOutcome): boolean =>
  o.passFraction > 0 && o.passFraction < 1;

/** Which stage each failure came from — the reason this suite exists. */
const stageOf = (failure: string): string =>
  failure.split(":", 1)[0] ?? "unknown";

/**
 * Watchdog ceiling — a chain repeat legitimately spans several LLM stages plus
 * vector-indexing waits, so it gets twice the single-service suites' budget.
 */
const REPEAT_DEADLINE_MS = 10 * 60_000;

const runCase = async (c: ChainEvalCase): Promise<CaseOutcome> => {
  const outcomes: RepeatOutcome[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = Date.now();
    let text = "";
    let failures: string[] = [];
    try {
      const r = await raceDeadline(
        () => c.run(fixtures),
        REPEAT_DEADLINE_MS,
        `${c.id} repeat ${(i + 1).toString()}`,
      );
      text = r.text;
      failures = r.failures;
    } catch (err) {
      failures = [`threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    outcomes.push({ text, failures, latencyMs: Date.now() - t0 });
  }
  const passCount = outcomes.filter((o) => o.failures.length === 0).length;
  return {
    caseId: c.id,
    passed: passCount === outcomes.length,
    passFraction: passCount / outcomes.length,
    repeats: outcomes,
    avgLatencyMs: Math.round(
      outcomes.reduce((a, o) => a + o.latencyMs, 0) / outcomes.length,
    ),
  };
};

const results: CaseOutcome[] = [];

const runAllPlain = async (): Promise<void> => {
  for (const c of cases) {
    const out = await runCase(c);
    results.push(out);
    console.log(
      `  ${out.passed ? "✓" : "✗"} ${c.id} (${(out.passFraction * repeats).toString()}/${repeats.toString()}, ~${out.avgLatencyMs.toString()}ms)`,
    );
  }
};

const runAllLangfuse = async (): Promise<void> => {
  const client = langfuseClient;
  if (!client) return runAllPlain();
  try {
    await client.dataset.get(DATASET_NAME);
  } catch {
    await client.api.datasets.create({
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
    });
    console.log(`+ dataset ${DATASET_NAME} created`);
  }
  for (const c of CHAIN_CASES) {
    await client.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: c.id,
      input: c.description,
      metadata: { caseId: c.id },
    });
  }
  const dataset = await client.dataset.get(DATASET_NAME);
  const wanted = new Set(cases.map((c) => c.id));
  const data = dataset.items.filter((item) => {
    const m = item.metadata;
    return (
      m !== null &&
      typeof m === "object" &&
      "caseId" in m &&
      typeof m.caseId === "string" &&
      wanted.has(m.caseId)
    );
  });
  const byId = new Map(cases.map((c) => [c.id, c]));

  const task: ExperimentTask = async (item) => {
    const meta = item.metadata;
    const caseId =
      meta && typeof meta === "object" && "caseId" in meta
        ? String(meta.caseId)
        : "";
    const c = byId.get(caseId);
    if (!c) {
      const empty: CaseOutcome = {
        caseId,
        passed: false,
        passFraction: 0,
        repeats: [{ text: "", failures: ["case not found"], latencyMs: 0 }],
        avgLatencyMs: 0,
      };
      return empty;
    }
    const out = await runCase(c);
    results.push(out);
    console.log(
      `  ${out.passed ? "✓" : "✗"} ${caseId} (${(out.passFraction * repeats).toString()}/${repeats.toString()}, ~${out.avgLatencyMs.toString()}ms)`,
    );
    return out;
  };

  const runEvaluators: RunEvaluator[] = [
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ itemResults }) => {
      const outs: CaseOutcome[] = itemResults.map((r) => r.output);
      if (outs.length === 0) return [];
      const mean = outs.reduce((a, o) => a + o.passFraction, 0) / outs.length;
      const bimodal = outs.filter(isBimodal);
      // Which stage is costing the chain the most — the number to act on.
      const byStage = new Map<string, number>();
      for (const o of outs) {
        for (const r of o.repeats) {
          for (const f of r.failures) {
            byStage.set(stageOf(f), (byStage.get(stageOf(f)) ?? 0) + 1);
          }
        }
      }
      const evaluations: Evaluation[] = [
        {
          name: "chain-mean-pass",
          value: Number(mean.toFixed(4)),
          dataType: "NUMERIC",
          comment: `${repeats.toString()} repeats/case`,
        },
        {
          name: "chain-cases-stable",
          value: outs.filter((o) => o.passed).length,
          dataType: "NUMERIC",
          comment: `of ${outs.length.toString()} cases`,
        },
        {
          name: "chain-cases-bimodal",
          value: bimodal.length,
          dataType: "NUMERIC",
          comment:
            bimodal.length === 0
              ? "none"
              : bimodal
                  .map(
                    (o) =>
                      `${o.caseId} ${(o.passFraction * repeats).toString()}/${repeats.toString()}`,
                  )
                  .join(", "),
        },
        {
          name: "chain-failures-by-stage",
          value: [...byStage.values()].reduce((a, n) => a + n, 0),
          dataType: "NUMERIC",
          comment:
            byStage.size === 0
              ? "none"
              : [...byStage.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, n]) => `${s}=${n.toString()}`)
                  .join(", "),
        },
      ];
      return evaluations;
    },
  ];

  const result = await client.experiment.run({
    name: "chain-eval",
    ...(opt("--run-name") ? { runName: opt("--run-name") } : {}),
    data,
    task,
    // Sequential: the destructive cases rebuild shared fixtures per repeat.
    maxConcurrency: 1,
    metadata: { repeats },
    runEvaluators,
    evaluators: [
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ output }) => {
        const out: CaseOutcome = output;
        const failures = out.repeats
          .flatMap((r) => r.failures)
          .slice(0, 6)
          .join(" | ");
        const evaluations: Evaluation[] = [
          {
            name: "chain-pass",
            value: out.passFraction,
            dataType: "NUMERIC",
            comment: out.passed ? "all repeats passed" : failures,
          },
          {
            name: "chain-latency-ms",
            value: out.avgLatencyMs,
            dataType: "NUMERIC",
          },
        ];
        return evaluations;
      },
    ],
  });

  // Same v4 gap as the other two runners — see `evals/recall/run.ts`.
  if (result.datasetRunId === undefined) {
    for (const evaluation of result.runEvaluations) {
      client.score.create({
        datasetRunId: result.experimentId,
        ...evaluation,
      });
    }
    await client.score.flush();
  }
  console.log(`[chain-eval] experiment ${result.experimentId}`);
  await flushLangfuse();
};

console.log(
  `[chain-eval] running ${cases.length.toString()} cases × ${repeats.toString()} repeats…`,
);
await runAllLangfuse();

console.log("\n================ CHAIN EVAL REPORT ================\n");
let passed = 0;
const stageTotals = new Map<string, number>();
for (const out of results) {
  if (out.passed) passed++;
  const mark = out.passed ? "✅" : isBimodal(out) ? "⚠️" : "❌";
  console.log(
    `${mark} ${out.caseId} — ${(out.passFraction * repeats).toString()}/${repeats.toString()} repeats, ~${out.avgLatencyMs.toString()}ms avg`,
  );
  out.repeats.forEach((r, i) => {
    const status = r.failures.length === 0 ? "ok" : r.failures.join("; ");
    for (const f of r.failures) {
      stageTotals.set(stageOf(f), (stageTotals.get(stageOf(f)) ?? 0) + 1);
    }
    console.log(`  · repeat ${(i + 1).toString()} [${status}]`);
    console.log(
      r.text
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  });
  console.log("");
}
const bimodal = results.filter(isBimodal);
console.log(
  `TOTAL: ${passed.toString()}/${results.length.toString()} cases fully stable (${repeats.toString()}/${repeats.toString()})`,
);
if (bimodal.length > 0) {
  console.log(
    `BIMODAL: ${bimodal
      .map(
        (o) =>
          `${o.caseId} ${(o.passFraction * repeats).toString()}/${repeats.toString()}`,
      )
      .join(", ")}`,
  );
}
if (stageTotals.size > 0) {
  console.log(
    `BY STAGE: ${[...stageTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}=${n.toString()}`)
      .join(", ")}`,
  );
}
process.exit(passed === results.length ? 0 : 1);
