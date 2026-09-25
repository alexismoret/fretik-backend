#!/usr/bin/env bun
/**
 * Decision-point eval — every point in `@fretik/shared/decisions/points.ts`,
 * asked of the REAL decision model through the REAL engine (`decidePoint`:
 * the registry's allow-list, budget, bars and transports), with the
 * question builders and verdict readers production uses. Cases live in
 * `./cases.ts`.
 *
 *   bun run evals:decisions                          # every case, 3 repeats
 *   bun run evals:decisions -- --repeats 10
 *   bun run evals:decisions -- --point drive.file    # repeatable
 *   bun run evals:decisions -- --case gate-invoice-runs
 *
 * A case passes a repeat when the product's outcome is one it lists; it
 * passes when every repeat does. The process exits 1 on any case below
 * 100 %, so this is the gate a point's bar or question is changed behind.
 * A decision call costs a few hundred-thousandths of a dollar: the whole
 * suite at ten repeats is well under one cent, printed at the end.
 *
 * Env (from `.env`): OPENROUTER_API_KEY; AI_GATEWAY_API_KEY for the
 * background points' fallback. Nothing is written to the database.
 */

import type { DecisionPointKey } from "@fretik/shared/decisions/keys";
import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { flushLangfuse } from "../../src/lib/langfuse";
import { decidePoint } from "../../src/services/decisions/decide-point";
import { exitAfterFlush } from "../exit";
import { DECISION_CASES, signalOf, type DecisionCase } from "./cases";

const argv = process.argv.slice(2);
const opts = (name: string): string[] =>
  argv.flatMap((arg, i) =>
    arg === name && argv[i + 1] ? [argv[i + 1] ?? ""] : [],
  );

const repeatsRaw = Number.parseInt(opts("--repeats")[0] ?? "", 10);
const REPEATS = Number.isFinite(repeatsRaw) && repeatsRaw > 0 ? repeatsRaw : 3;
/** Calls in flight at once — far under the provider's 1 200 a minute. */
const CONCURRENCY = 8;

const points = new Set(opts("--point"));
const ids = new Set(opts("--case"));
const cases = DECISION_CASES.filter(
  (c) =>
    (points.size === 0 || points.has(c.point)) &&
    (ids.size === 0 || ids.has(c.id)),
);
if (cases.length === 0) {
  console.error("No case matches the filters.");
  process.exit(1);
}

const context = {
  teamId: process.env.EVAL_TEAM_ID ?? "eval-decisions",
  ...(process.env.EVAL_ORGANIZATION_ID
    ? { organizationId: process.env.EVAL_ORGANIZATION_ID }
    : {}),
};

interface Attempt {
  outcome: string;
  pass: boolean;
  signal: string;
  latencyMs: number | null;
  costUsd: number;
  transport: string | null;
}

/**
 * The engine's per-minute budget refuses what goes over it, and a refusal is
 * not the model's answer: the whole suite at ten repeats is 1 140 calls, past
 * the 1 000 a minute allows (background points stop at 800), and the calls
 * past it read as failures. A refused call waits for the next minute's window
 * and is asked again.
 */
const BUDGET_RETRIES = 3;

const ask = async (c: DecisionCase): Promise<DecisionResponse | null> => {
  for (let tries = 0; ; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await decidePoint(c.request, context);
    const refused =
      response?.status === "skipped" && response.reason === "rate_limited";
    if (!refused || tries >= BUDGET_RETRIES) return response;
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(60_000 - (Date.now() % 60_000) + 500);
  }
};

const attempt = async (c: DecisionCase): Promise<Attempt> => {
  let response: DecisionResponse | null = null;
  try {
    response = await ask(c);
  } catch (error) {
    console.warn(
      `[${c.id}] engine threw:`,
      error instanceof Error ? error.message : error,
    );
  }
  const outcome = c.read(response);
  return {
    outcome,
    pass: c.expect.includes(outcome),
    signal: signalOf(response),
    latencyMs: response?.status === "answered" ? response.latencyMs : null,
    costUsd: response?.status === "answered" ? (response.costUsd ?? 0) : 0,
    transport: response?.status === "answered" ? response.transport : null,
  };
};

/** Every (case, repeat) pair, run CONCURRENCY at a time. */
const jobs = cases.flatMap((c) => Array.from({ length: REPEATS }, () => c));
const results = new Map<string, Attempt[]>();
let next = 0;
const worker = async (): Promise<void> => {
  while (next < jobs.length) {
    const c = jobs[next];
    next += 1;
    if (c === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    const result = await attempt(c);
    results.set(c.id, [...(results.get(c.id) ?? []), result]);
  }
};

const startedAt = Date.now();
console.log(
  `Decision eval: ${cases.length.toString()} case(s) × ${REPEATS.toString()} repeat(s)\n`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const percentile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null
  );
};

const byPoint = new Map<DecisionPointKey, DecisionCase[]>();
for (const c of cases)
  byPoint.set(c.point, [...(byPoint.get(c.point) ?? []), c]);

let failedCases = 0;
let totalCost = 0;
const allLatencies: number[] = [];
const gatewayAnswers: string[] = [];

for (const [point, pointCases] of byPoint) {
  const latencies: number[] = [];
  let passed = 0;
  console.log(`── ${point}`);
  for (const c of pointCases) {
    const attempts = results.get(c.id) ?? [];
    const passes = attempts.filter((a) => a.pass).length;
    const ok = passes === attempts.length && attempts.length > 0;
    if (ok) passed += 1;
    else failedCases += 1;
    for (const a of attempts) {
      totalCost += a.costUsd;
      if (a.latencyMs !== null) latencies.push(a.latencyMs);
      if (a.transport === "gateway") gatewayAnswers.push(c.id);
    }
    const outcomes = [...new Set(attempts.map((a) => a.outcome))].join(" | ");
    console.log(
      `  ${ok ? "PASS" : "FAIL"} ${passes.toString()}/${attempts.length.toString()}  ${c.id}  → ${outcomes}${ok ? "" : `  (expected ${c.expect.join(" | ")})`}`,
    );
    if (!ok) {
      console.log(`       ${c.why}`);
      for (const a of attempts.filter((x) => !x.pass)) {
        console.log(`       got ${a.outcome}: ${a.signal}`);
      }
    } else {
      console.log(`       ${attempts[0]?.signal ?? ""}`);
    }
  }
  allLatencies.push(...latencies);
  console.log(
    `  ${passed.toString()}/${pointCases.length.toString()} cases · p50 ${String(percentile(latencies, 0.5))} ms · p95 ${String(percentile(latencies, 0.95))} ms\n`,
  );
}

console.log("══════════════════════════════════════════");
console.log(
  `${(cases.length - failedCases).toString()}/${cases.length.toString()} cases at 100 % over ${REPEATS.toString()} repeat(s)`,
);
console.log(
  `latency p50 ${String(percentile(allLatencies, 0.5))} ms · p95 ${String(percentile(allLatencies, 0.95))} ms · cost $${totalCost.toFixed(6)} · ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
);
if (gatewayAnswers.length > 0) {
  // Acted on in production, never calibrated on: the gateway's model floats.
  console.log(
    `${gatewayAnswers.length.toString()} answer(s) came from the gateway fallback (${[...new Set(gatewayAnswers)].join(", ")})`,
  );
}

await flushLangfuse();
await exitAfterFlush(failedCases === 0 ? 0 : 1);
