#!/usr/bin/env bun
/**
 * Recall eval runner (P5-bis) — scores the memory BLOCK itself.
 *
 * Unlike `evals:langfuse` (full chatbot turns over HTTP), this runs
 * `runUnifiedRecall` IN-PROCESS against the eval team: seed the fixture
 * universe (idempotent), run every case N times (`--repeats`, default 3 —
 * retrieval + judge variance is part of the system under test), assert
 * deterministically on the generated block (must-cite / must-not-cite
 * markers, NONE expectations, size + selectivity caps), and push a
 * `recall-eval` dataset run to Langfuse so iterations compare in the UI.
 * Every generated block is printed for human analysis.
 *
 *   bun run evals:recall                    # all cases, 3 repeats
 *   bun run evals:recall -- --case rec-typo-record
 *   bun run evals:recall -- --repeats 5
 *   bun run evals:recall -- --run-name after-prompt-v4
 *   bun run evals:recall -- --cleanup       # tear the fixtures down
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
import {
  runUnifiedRecall,
  type UnifiedRecallResult,
} from "../../src/services/recall/recall";
import { raceDeadline } from "../deadline";
import { RECALL_CASES, type RecallEvalCase } from "./cases";
import {
  cleanupRecallFixtures,
  ensureRecallFixtures,
  type RecallFixtures,
} from "./fixtures";

const DATASET_NAME = "recall-eval";
const DATASET_DESCRIPTION =
  "Recall (unified memory) eval — the generated <active_memory> block is scored directly against the fixture universe. Source of truth = backend/packages/ai/evals/recall.";
const DEFAULT_REPEATS = 3;
const MAX_BLOCK_CHARS = 2_000;

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
  console.error(
    "Missing EVAL_TEAM_ID / EVAL_ORGANIZATION_ID / EVAL_USER_ID in env",
  );
  process.exit(1);
}

if (flag("--cleanup")) {
  await cleanupRecallFixtures(scope);
  process.exit(0);
}

const repeatsRaw = Number.parseInt(opt("--repeats") ?? "", 10);
const repeats =
  Number.isFinite(repeatsRaw) && repeatsRaw > 0 ? repeatsRaw : DEFAULT_REPEATS;
/** Force the judge onto a registry profile — the model bake-off (20b vs 120b). */
const judgeProfileKey = opt("--judge-profile");
const onlyCase = opt("--case");
const cases = onlyCase
  ? RECALL_CASES.filter((c) => c.id === onlyCase)
  : RECALL_CASES;
if (cases.length === 0) {
  console.error(`No case matches --case ${onlyCase ?? ""}`);
  process.exit(1);
}

console.log("[recall-eval] ensuring fixtures (idempotent)…");
const fixtures: RecallFixtures = await ensureRecallFixtures(scope);
console.log("[recall-eval] fixtures ready");

/** Failure strings for ONE repeat ([] = pass). */
const evaluateRepeat = (
  c: RecallEvalCase,
  fx: RecallFixtures,
  result: UnifiedRecallResult | null,
): string[] => {
  const failures: string[] = [];
  // The capability channel is judge-free and has its own budget, so `result`
  // can be non-null with an EMPTY memory block (a workflow matched, the judge
  // said NONE) — the memory assertions key on the block, never on `result`.
  const capability = result?.capabilityBlock;
  if (c.expectCapability === true && capability === undefined) {
    failures.push("expected a capability, got none");
  }
  if (c.expectCapability === false && capability !== undefined) {
    failures.push(
      `expected no capability, got: "${capability.slice(0, 120)}…"`,
    );
  }
  for (const marker of c.mustCiteCapability?.(fx) ?? []) {
    if (capability === undefined || !capability.includes(marker)) {
      failures.push(`missing capability marker ${marker}`);
    }
  }

  const block = result?.block ?? "";
  if (block.length === 0) {
    if (c.expectBlock === true) failures.push("expected a block, got NONE");
    return failures;
  }
  if (c.expectBlock === false) {
    failures.push(`expected NONE, got a block: "${block.slice(0, 120)}…"`);
    return failures;
  }
  if (block.length > MAX_BLOCK_CHARS) {
    failures.push(
      `block ${block.length.toString()} chars > ${MAX_BLOCK_CHARS.toString()}`,
    );
  }
  for (const marker of c.mustCite?.(fx) ?? []) {
    if (!block.includes(marker)) failures.push(`missing marker ${marker}`);
  }
  for (const marker of c.mustNotCite?.(fx) ?? []) {
    if (block.includes(marker)) failures.push(`forbidden marker ${marker}`);
  }
  if (c.maxRecordMarkers !== undefined) {
    const n = (block.match(/\(record:/g) ?? []).length;
    if (n > c.maxRecordMarkers) {
      failures.push(
        `${n.toString()} record markers > cap ${c.maxRecordMarkers.toString()} (selectivity)`,
      );
    }
  }
  return failures;
};

interface RepeatOutcome {
  block: string | null;
  capability: string | null;
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

/**
 * A case that neither always passes nor always fails over its repeats — the
 * failure mode the all-or-nothing gate cannot express. At the default 3
 * repeats a 58%-stable case reads as a pass or a fail depending on the draw
 * (measured on `rec-multi-domain`, 7/12 across three runs), so the count is
 * surfaced explicitly rather than left to be inferred from a flipping verdict.
 */
const isBimodal = (o: CaseOutcome): boolean =>
  o.passFraction > 0 && o.passFraction < 1;

/** Watchdog ceiling — far above any legitimate repeat (judge timeout is 15 s). */
const REPEAT_DEADLINE_MS = 5 * 60_000;

const runCase = async (c: RecallEvalCase): Promise<CaseOutcome> => {
  const outcomes: RepeatOutcome[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = Date.now();
    // `runUnifiedRecall` never throws by design, so the only rejection here is
    // the watchdog's — recorded as a failure instead of crashing the suite.
    let result: UnifiedRecallResult | null = null;
    let hung: string | null = null;
    try {
      result = await raceDeadline(
        () =>
          runUnifiedRecall({
            organizationId: scope.organizationId,
            teamId: scope.teamId,
            userId: c.asUser === false ? undefined : scope.userId,
            agentType: "chatbot",
            userMessage: c.message,
            attachedFiles: [],
            recentTail: c.recentTail ?? "",
            bypassCache: true,
            judgeProfileKey,
          }),
        REPEAT_DEADLINE_MS,
        `${c.id} repeat ${(i + 1).toString()}`,
      );
    } catch (err) {
      hung = err instanceof Error ? err.message : String(err);
    }
    outcomes.push({
      block: result?.block ?? null,
      capability: result?.capabilityBlock ?? null,
      failures: hung !== null ? [hung] : evaluateRepeat(c, fixtures, result),
      latencyMs: Date.now() - t0,
    });
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

// ---------------------------------------------------------------------------
// Execution — through a Langfuse experiment when configured (dataset run +
// per-item traces/scores), plain loop otherwise. One execution either way.
// ---------------------------------------------------------------------------

const results: CaseOutcome[] = [];

const runAllPlain = async (): Promise<void> => {
  for (const c of cases) {
    results.push(await runCase(c));
    const last = results[results.length - 1];
    if (last) {
      console.log(
        `  ${last.passed ? "✓" : "✗"} ${c.id} (${(last.passFraction * repeats).toString()}/${repeats.toString()} repeats, ~${last.avgLatencyMs.toString()}ms)`,
      );
    }
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
  for (const c of RECALL_CASES) {
    await client.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: c.id,
      input: c.message,
      metadata: { caseId: c.id, description: c.description },
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
        repeats: [
          {
            block: null,
            capability: null,
            failures: ["case not found in code"],
            latencyMs: 0,
          },
        ],
        avgLatencyMs: 0,
      };
      return empty;
    }
    const outcome = await runCase(c);
    results.push(outcome);
    console.log(
      `  ${outcome.passed ? "✓" : "✗"} ${caseId} (${(outcome.passFraction * repeats).toString()}/${repeats.toString()} repeats, ~${outcome.avgLatencyMs.toString()}ms)`,
    );
    return outcome;
  };

  // Run-level aggregates — without them a run is only comparable case by case
  // in the UI, which is how a whole-suite drift stays invisible.
  const runEvaluators: RunEvaluator[] = [
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ itemResults }) => {
      const outs: CaseOutcome[] = itemResults.map((r) => r.output);
      if (outs.length === 0) return [];
      const mean = outs.reduce((a, o) => a + o.passFraction, 0) / outs.length;
      const bimodal = outs.filter(isBimodal);
      const evaluations: Evaluation[] = [
        {
          name: "recall-mean-pass",
          value: Number(mean.toFixed(4)),
          dataType: "NUMERIC",
          comment: `${repeats.toString()} repeats/case`,
        },
        {
          name: "recall-cases-stable",
          value: outs.filter((o) => o.passed).length,
          dataType: "NUMERIC",
          comment: `of ${outs.length.toString()} cases`,
        },
        {
          name: "recall-cases-bimodal",
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
      ];
      return evaluations;
    },
  ];

  const result = await client.experiment.run({
    name: "recall-eval",
    ...(opt("--run-name") ? { runName: opt("--run-name") } : {}),
    data,
    task,
    maxConcurrency: 2,
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
            name: "recall-pass",
            value: out.passFraction,
            dataType: "NUMERIC",
            comment: out.passed ? "all repeats passed" : failures,
          },
          {
            name: "recall-latency-ms",
            value: out.avgLatencyMs,
            dataType: "NUMERIC",
          },
        ];
        return evaluations;
      },
    ],
  });

  // Same v4 gap the chatbot eval hits (`evals/langfuse/experiment.ts`): the SDK
  // still links dataset-run items over the v3 endpoint, which a server in
  // `events_only` mode no longer serves. `datasetRunId` comes back undefined
  // and the ExperimentManager then SKIPS persisting the run-level evaluations —
  // the per-item scores and traces land fine either way. Attach them to the
  // experiment id, which rode in on the OTel experiment attributes.
  if (result.datasetRunId === undefined) {
    for (const evaluation of result.runEvaluations) {
      client.score.create({
        datasetRunId: result.experimentId,
        ...evaluation,
      });
    }
    await client.score.flush();
  }
  console.log(
    `[recall-eval] experiment ${result.experimentId} — ${result.runEvaluations.length.toString()} run-level scores`,
  );
  await flushLangfuse();
};

console.log(
  `[recall-eval] running ${cases.length.toString()} cases × ${repeats.toString()} repeats…`,
);
await runAllLangfuse();

// ---------------------------------------------------------------------------
// Human-analysis report — every generated block, per repeat.
// ---------------------------------------------------------------------------
console.log("\n================ RECALL EVAL REPORT ================\n");
let passed = 0;
for (const out of results) {
  if (out.passed) passed++;
  // ⚠️ = bimodal: the case flips between repeats, so its all-or-nothing
  // verdict is a coin toss at this repeat count — read the fraction, not ✅/❌.
  const mark = out.passed ? "✅" : isBimodal(out) ? "⚠️" : "❌";
  console.log(
    `${mark} ${out.caseId} — ${(out.passFraction * repeats).toString()}/${repeats.toString()} repeats, ~${out.avgLatencyMs.toString()}ms avg`,
  );
  out.repeats.forEach((r, i) => {
    const status = r.failures.length === 0 ? "ok" : r.failures.join("; ");
    console.log(`  · repeat ${(i + 1).toString()} [${status}]`);
    console.log(
      r.block === null || r.block.length === 0
        ? "    NONE"
        : r.block
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n"),
    );
    if (r.capability !== null) console.log(`    [capability] ${r.capability}`);
  });
  console.log("");
}
const bimodal = results.filter(isBimodal);
console.log(
  `TOTAL: ${passed.toString()}/${results.length.toString()} cases fully stable (${repeats.toString()}/${repeats.toString()} repeats)`,
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
process.exit(passed === results.length ? 0 : 1);
