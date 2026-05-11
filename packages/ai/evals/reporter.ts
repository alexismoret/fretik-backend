/**
 * Report renderer for the eval harness. Not a test file.
 *
 * Emits two artifacts per run:
 *   - A JSON dump at `.eval-runs/<timestamp>.json` (full `RunReport`,
 *     durable for regression diffing).
 *   - A Markdown summary on stdout (per-suite pass/fail + per-case
 *     failing-assertion details + latency histogram).
 *
 * The JSON is the source of truth. The stdout markdown is for the
 * developer running `bun run evals` at their terminal.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssertionResult, RunReport, SuiteReport } from "./types";

const fmtMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const statusIcon = (passed: boolean): string => (passed ? "✓" : "✗");

const formatAssertion = (a: AssertionResult): string => {
  const head = `    ${statusIcon(a.passed)} ${a.label}`;
  return a.message ? `${head}\n        → ${a.message}` : head;
};

const formatSuite = (s: SuiteReport): string[] => {
  const lines: string[] = [];
  lines.push(
    `\n## ${s.suite} — ${s.passed}/${s.total} passed${s.failed > 0 ? ` (${s.failed} failed)` : ""}`,
  );
  for (const c of s.cases) {
    const turn = fmtMs(c.invoke.latencyMs);
    const model = fmtMs(c.invoke.modelLatencyMs);
    const tool = fmtMs(c.invoke.toolLatencyMs);
    lines.push(
      `  ${statusIcon(c.passed)} [${c.caseId}] ${c.description} (turn=${turn}, model=${model}, tools=${tool}, ${c.invoke.toolCalls.length} calls)`,
    );
    const failed = c.assertions.filter((a) => !a.passed);
    if (failed.length > 0) {
      for (const a of failed) lines.push(formatAssertion(a));
    }
  }
  return lines;
};

const formatPerTool = (report: RunReport): string[] => {
  if (report.totals.perTool.length === 0) return [];
  const lines: string[] = [
    "",
    "## per-tool latency (sorted by p95, slowest first)",
  ];
  for (const t of report.totals.perTool) {
    lines.push(
      `  ${t.tool.padEnd(22)} ${String(t.calls).padStart(3)} calls   p50=${fmtMs(t.medianMs).padStart(7)}   p95=${fmtMs(t.p95Ms).padStart(7)}`,
    );
  }
  return lines;
};

const banner = (report: RunReport): string[] => [
  "",
  "=".repeat(72),
  `Fretik Chatbot Evals`,
  `  started:    ${report.startedAt}`,
  `  duration:   ${fmtMs(report.durationMs)}`,
  `  service:    ${report.env.aiServiceUrl}`,
  `  team:       ${report.env.teamId}`,
  `  totals:     ${report.totals.passed}/${report.totals.cases} passed` +
    (report.totals.failed > 0 ? ` (${report.totals.failed} failed)` : ""),
  `  turn:       median ${fmtMs(report.totals.turnLatency.medianMs)}, p95 ${fmtMs(report.totals.turnLatency.p95Ms)}`,
  `  model:      median ${fmtMs(report.totals.modelLatency.medianMs)}, p95 ${fmtMs(report.totals.modelLatency.p95Ms)}`,
  `  tools sum:  median ${fmtMs(report.totals.toolLatency.medianMs)}, p95 ${fmtMs(report.totals.toolLatency.p95Ms)}`,
  "=".repeat(72),
];

export const renderMarkdown = (report: RunReport): string => {
  const lines: string[] = [...banner(report)];
  for (const s of report.suites) lines.push(...formatSuite(s));
  lines.push(...formatPerTool(report));
  lines.push("");
  return lines.join("\n");
};

export const writeJsonReport = async (
  report: RunReport,
  outDir: string,
): Promise<string> => {
  await mkdir(outDir, { recursive: true });
  const ts = report.startedAt.replace(/[:.]/g, "-");
  const filePath = path.join(outDir, `${ts}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2));
  return filePath;
};
