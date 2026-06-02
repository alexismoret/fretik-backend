/**
 * ==================================================================
 *   Fretik Chatbot — Live LLM Eval Harness (Phase 10)
 * ==================================================================
 *
 * This is NOT a unit test. Tests live in `../tests/` and run via
 * `bun test` — they're deterministic, mock external deps, and are
 * safe in CI.
 *
 * Evals in THIS folder (`../evals/`) call the REAL chatbot stack
 * end-to-end. Each run:
 *   1. Posts a prompt to `POST AI_SERVICE_URL/internal/agents/chatbot/invoke`
 *   2. Consumes the returned UIMessage stream
 *   3. Runs assertions (local checks + LLM-as-judge) on the result
 *   4. Writes a JSON report under `.eval-runs/` and prints a Markdown
 *      summary to stdout
 *
 * Non-deterministic by nature — same prompt can produce different
 * tool traces and wording across runs. That's the point: we're
 * validating model behaviour, not code behaviour.
 *
 * ── Required environment ───────────────────────────────────────────
 *
 * The harness itself:
 *   AI_SERVICE_URL            e.g. http://localhost:8083
 *   INTERNAL_KEY           same value the @fretik/ai process uses
 *   EVAL_TEAM_ID              UUID of the team to eval against
 *   EVAL_ORGANIZATION_ID      parent organization UUID
 *   EVAL_USER_ID    (opt.)    forwarded as X-Context-User-Id
 *   EVAL_USER_NAME  (opt.)    forwarded as X-Context-User-Name
 *   EVAL_TIMEZONE   (opt.)    IANA name (e.g. Europe/Paris)
 *
 * The judge (LLM-as-judge):
 *   OPENROUTER_API_KEY           required
 *   OPENROUTER_EVAL_JUDGE_MODEL  optional (default: google/gemini-3.5-flash)
 *
 * Plus whatever `@fretik/ai` itself needs to run (OPENROUTER_CHAT_MODEL,
 * DATABASE_URL, REDIS_URL, ...) — those belong to the service you're
 * pointing `AI_SERVICE_URL` at, not to this harness.
 *
 * ── Invocation ─────────────────────────────────────────────────────
 *
 *   cd backend/packages/ai
 *   bun run evals                      # run all suites
 *   bun run evals -- --suite simple-qa # single suite
 *   bun run evals -- --tag rag         # only cases tagged "rag"
 *   bun run evals -- --concurrency 5   # default is 3
 *
 * The harness does NOT persist any conversation (each case is a
 * stateless `/internal/invoke` call without conversationId). No DB
 * writes beyond whatever side-effects the tools themselves produce
 * (RAG caches, persisted-output etc. behave normally).
 *
 * ── Reading the report ─────────────────────────────────────────────
 *
 *   ✓  assertion passed
 *   ✗  assertion failed (failing assertions show their message)
 *
 * A failing `judge` assertion includes the judge's one-line rationale,
 * so you can tell whether the agent was wrong or the rubric was
 * ambiguous. Adjust rubrics iteratively when they're the bottleneck.
 * ==================================================================
 */

import path from "node:path";
import { allSuites } from "./cases";
import { runChatbotExperiment } from "./langfuse/experiment";
import { renderMarkdown, writeJsonReport } from "./reporter";
import { filterCasesByTag, pool, runCase } from "./runner";
import type {
  Capability,
  CaseResult,
  LatencyStats,
  PerToolLatency,
  RunReport,
  SuiteReport,
} from "./types";

interface CliOptions {
  suite?: string;
  tag?: string;
  concurrency: number;
  /** Run as a Langfuse experiment (dataset run) instead of a local report. */
  langfuse: boolean;
  /** With --langfuse: PR smoke subset only. */
  smoke: boolean;
  /** With --langfuse: one capability stratum. */
  capability?: Capability;
  /** With --langfuse: skip the judge (deterministic only). */
  deterministicOnly: boolean;
  /** With --langfuse: explicit dataset-run name. */
  runName?: string;
}

const isCapability = (v: string): v is Capability =>
  v === "extraction" ||
  v === "generation" ||
  v === "external-actions" ||
  v === "reasoning";

const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = {
    concurrency: 3,
    langfuse: false,
    smoke: false,
    deterministicOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--suite" && next) {
      opts.suite = next;
      i++;
      continue;
    }
    if (flag === "--tag" && next) {
      opts.tag = next;
      i++;
      continue;
    }
    if (flag === "--concurrency" && next) {
      const n = parseInt(next, 10);
      if (!Number.isNaN(n) && n > 0) opts.concurrency = n;
      i++;
      continue;
    }
    if (flag === "--langfuse") {
      opts.langfuse = true;
      continue;
    }
    if (flag === "--smoke") {
      opts.smoke = true;
      continue;
    }
    if (flag === "--deterministic-only") {
      opts.deterministicOnly = true;
      continue;
    }
    if (flag === "--capability" && next && isCapability(next)) {
      opts.capability = next;
      i++;
      continue;
    }
    if (flag === "--run-name" && next) {
      opts.runName = next;
      i++;
      continue;
    }
  }
  return opts;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] ?? 0;
    const b = sorted[mid] ?? 0;
    return (a + b) / 2;
  }
  return sorted[mid] ?? 0;
};

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx] ?? 0;
};

const runLangfuse = async (opts: CliOptions): Promise<void> => {
  const result = await runChatbotExperiment({
    smoke: opts.smoke,
    deterministicOnly: opts.deterministicOnly,
    maxConcurrency: opts.concurrency,
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.runName ? { runName: opts.runName } : {}),
    metadata: {
      release: process.env.LANGFUSE_RELEASE ?? "(dev)",
      smoke: opts.smoke,
      deterministicOnly: opts.deterministicOnly,
    },
  });
  console.log(await result.format({ includeItemResults: true }));
  if (result.datasetRunUrl)
    console.log(`\n[evals] dataset run: ${result.datasetRunUrl}`);
  process.exit(0);
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.langfuse) {
    await runLangfuse(opts);
    return;
  }
  const startedAt = new Date();
  const selected = opts.suite
    ? allSuites.filter((s) => s.name === opts.suite)
    : allSuites;

  if (selected.length === 0) {
    console.error(
      `No suite matched --suite=${opts.suite}. Known suites: ${allSuites.map((s) => s.name).join(", ")}`,
    );
    process.exit(2);
  }

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "(unset)";
  const teamId = process.env.EVAL_TEAM_ID ?? "(unset)";
  const organizationId = process.env.EVAL_ORGANIZATION_ID ?? "(unset)";

  const suiteReports: SuiteReport[] = [];
  for (const suite of selected) {
    const cases = filterCasesByTag(suite, opts.tag);
    if (cases.length === 0) continue;
    console.log(
      `[evals] suite=${suite.name} cases=${cases.length} concurrency=${opts.concurrency}`,
    );
    const results: CaseResult[] = [];
    // eslint-disable-next-line no-await-in-loop -- we run one suite at
    // a time to keep the per-suite log output grouped; within a suite
    // `pool()` parallelises by `concurrency`.
    await pool(cases, opts.concurrency, async (c) => {
      const res = await runCase(suite, c);
      results.push(res);
      console.log(
        `  ${res.passed ? "✓" : "✗"} [${res.caseId}] ${res.description} (${res.invoke.latencyMs}ms)`,
      );
    });
    // Re-sort to preserve the case-file ordering in the report.
    const byId = new Map(cases.map((c, i) => [c.id, i]));
    results.sort(
      (a, b) => (byId.get(a.caseId) ?? 0) - (byId.get(b.caseId) ?? 0),
    );
    suiteReports.push({
      suite: suite.name,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      cases: results,
    });
  }

  const finishedAt = new Date();
  const allCaseResults = suiteReports.flatMap((s) => s.cases);

  const buildLatencyStats = (samples: number[]): LatencyStats => ({
    samples: samples.length,
    medianMs: median(samples),
    p95Ms: percentile(samples, 95),
    totalMs: samples.reduce((a, b) => a + b, 0),
  });

  const turnSamples = allCaseResults.map((r) => r.invoke.latencyMs);
  const toolTurnSamples = allCaseResults.map((r) => r.invoke.toolLatencyMs);
  const modelSamples = allCaseResults.map((r) => r.invoke.modelLatencyMs);

  // Per-tool breakdown: group every individual tool call across every
  // case by its tool name, then compute p50/p95 on the PER-CALL
  // latency samples (not per-turn sums). This is what surfaces
  // "searchKnowledge calls take 15s median" independent of how many
  // times any given turn calls it.
  const perToolSamples = new Map<string, number[]>();
  for (const r of allCaseResults) {
    for (const call of r.invoke.toolCalls) {
      if (call.latencyMs === undefined) continue;
      const list = perToolSamples.get(call.name) ?? [];
      list.push(call.latencyMs);
      perToolSamples.set(call.name, list);
    }
  }
  const perTool: PerToolLatency[] = [...perToolSamples.entries()]
    .map(([tool, samples]) => ({
      tool,
      calls: samples.length,
      medianMs: median(samples),
      p95Ms: percentile(samples, 95),
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms);

  const report: RunReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    env: { aiServiceUrl, teamId, organizationId },
    suites: suiteReports,
    totals: {
      cases: allCaseResults.length,
      passed: allCaseResults.filter((r) => r.passed).length,
      failed: allCaseResults.filter((r) => !r.passed).length,
      turnLatency: buildLatencyStats(turnSamples),
      toolLatency: buildLatencyStats(toolTurnSamples),
      modelLatency: buildLatencyStats(modelSamples),
      perTool,
    },
  };

  const outDir = path.resolve(import.meta.dirname, "..", ".eval-runs");
  const jsonPath = await writeJsonReport(report, outDir);
  console.log(renderMarkdown(report));
  console.log(`[evals] JSON report written to ${jsonPath}`);

  process.exit(report.totals.failed > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error("[evals] fatal:", err);
  process.exit(3);
});
