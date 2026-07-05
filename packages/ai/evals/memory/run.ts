#!/usr/bin/env bun
/**
 * Memory-generation eval runner — scores the LLM outputs of the unified-memory
 * plan OTHER than recall (distill-conversation, record-activity digest, the
 * MERGE/REVISE/NOOP consolidation judge, mention extraction, relation
 * extraction, and episode→semantic promotion). Runs the REAL
 * services in-process against the fixture universe, N times each (`--repeats`),
 * asserts deterministically, and PRINTS every generated text for human quality
 * analysis. `--profile` forces a registry profile for the model bake-off; a
 * `memory-eval` dataset run lands in Langfuse for UI comparison.
 *
 *   bun run evals:memory                              # code defaults (20b), 3 repeats
 *   bun run evals:memory -- --profile gpt-oss-120b    # bake-off: everything on 120b
 *   bun run evals:memory -- --case mem-consolidate-merge
 *   bun run evals:memory -- --repeats 5 --run-name distill-120b
 *   bun run evals:memory -- --cleanup                 # tear the fixtures down
 *
 * Env (from `.env`): DATABASE_URL, OPENROUTER_API_KEY, LANGFUSE_*,
 * EVAL_TEAM_ID, EVAL_ORGANIZATION_ID, EVAL_USER_ID.
 */

import type { Evaluation, ExperimentTask } from "@langfuse/client";
import { flushLangfuse, langfuseClient } from "../../src/lib/langfuse";
import { MEMORY_CASES, type MemoryEvalCase } from "./cases";
import {
  cleanupMemoryFixtures,
  ensureMemoryFixtures,
  type MemoryFixtures,
} from "./fixtures";

const DATASET_NAME = "memory-eval";
const DATASET_DESCRIPTION =
  "Memory-generation eval — distill-conversation / record-activity digest / consolidation judge / mention extraction / relation extraction / episode promotion. Source of truth = backend/packages/ai/evals/memory.";
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
  await cleanupMemoryFixtures(scope);
  process.exit(0);
}

const repeatsRaw = Number.parseInt(opt("--repeats") ?? "", 10);
const repeats =
  Number.isFinite(repeatsRaw) && repeatsRaw > 0 ? repeatsRaw : DEFAULT_REPEATS;
const profileKey = opt("--profile");
const onlyCase = opt("--case");
const cases = onlyCase
  ? MEMORY_CASES.filter((c) => c.id === onlyCase)
  : MEMORY_CASES;
if (cases.length === 0) {
  console.error(`No case matches --case ${onlyCase ?? ""}`);
  process.exit(1);
}

console.log(
  `[memory-eval] profile=${profileKey ?? "(code default: 20b)"} — ensuring fixtures…`,
);
const fixtures: MemoryFixtures = await ensureMemoryFixtures(scope);
console.log("[memory-eval] fixtures ready");

interface RepeatOutcome {
  text: string;
  failures: string[];
  latencyMs: number;
}
interface CaseOutcome {
  caseId: string;
  task: string;
  passed: boolean;
  passFraction: number;
  repeats: RepeatOutcome[];
  avgLatencyMs: number;
}

const runCase = async (c: MemoryEvalCase): Promise<CaseOutcome> => {
  const outcomes: RepeatOutcome[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = Date.now();
    let text = "";
    let failures: string[] = [];
    try {
      const r = await c.run(fixtures, profileKey);
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
    task: c.task,
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
    const outcome = await runCase(c);
    results.push(outcome);
    console.log(
      `  ${outcome.passed ? "✓" : "✗"} ${c.id} (${(outcome.passFraction * repeats).toString()}/${repeats.toString()}, ~${outcome.avgLatencyMs.toString()}ms)`,
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
  for (const c of MEMORY_CASES) {
    await client.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: c.id,
      input: c.description,
      metadata: { caseId: c.id, task: c.task },
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
        task: "?",
        passed: false,
        passFraction: 0,
        repeats: [{ text: "", failures: ["case not found"], latencyMs: 0 }],
        avgLatencyMs: 0,
      };
      return empty;
    }
    const outcome = await runCase(c);
    results.push(outcome);
    console.log(
      `  ${outcome.passed ? "✓" : "✗"} ${caseId} (${(outcome.passFraction * repeats).toString()}/${repeats.toString()}, ~${outcome.avgLatencyMs.toString()}ms)`,
    );
    return outcome;
  };

  await client.experiment.run({
    name: "memory-eval",
    ...(opt("--run-name") ? { runName: opt("--run-name") } : {}),
    data,
    task,
    maxConcurrency: 1,
    metadata: { repeats, profile: profileKey ?? "code-default" },
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
            name: "memory-pass",
            value: out.passFraction,
            dataType: "NUMERIC",
            comment: out.passed ? "all repeats passed" : failures,
          },
          {
            name: "memory-latency-ms",
            value: out.avgLatencyMs,
            dataType: "NUMERIC",
          },
        ];
        return evaluations;
      },
    ],
  });
  await flushLangfuse();
};

console.log(
  `[memory-eval] running ${cases.length.toString()} cases × ${repeats.toString()} repeats…`,
);
await runAllLangfuse();

// ---------------------------------------------------------------------------
// Human-analysis report — every generated text, per repeat.
// ---------------------------------------------------------------------------
console.log("\n================ MEMORY EVAL REPORT ================");
console.log(`profile: ${profileKey ?? "(code default: gpt-oss-20b)"}\n`);
let passed = 0;
for (const out of results) {
  if (out.passed) passed++;
  console.log(
    `${out.passed ? "✅" : "❌"} ${out.caseId} [${out.task}] — ${(out.passFraction * repeats).toString()}/${repeats.toString()}, ~${out.avgLatencyMs.toString()}ms`,
  );
  out.repeats.forEach((r, i) => {
    const status = r.failures.length === 0 ? "ok" : r.failures.join("; ");
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
console.log(
  `TOTAL: ${passed.toString()}/${results.length.toString()} cases fully stable (${repeats.toString()}/${repeats.toString()})`,
);
process.exit(passed === results.length ? 0 : 1);
