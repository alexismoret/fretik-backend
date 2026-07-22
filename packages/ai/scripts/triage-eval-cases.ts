#!/usr/bin/env bun
/**
 * Triage the existing eval cases before migrating them into the Langfuse
 * `chatbot-eval` dataset.
 *
 * The cases were authored in a session, NOT drawn from real usage, so
 * most need rewriting or dropping. A strong model (Gemini, a DIFFERENT
 * family than the agent) scores each case — prompt clarity, rubric
 * clarity, regression value, capability bucket — and returns
 * `keep | rewrite | drop` with a suggested rewrite. Output is a report
 * for HUMAN validation: nothing is migrated automatically. After you
 * approve the shortlist, add `capability` (and `smoke`) to the kept
 * cases in `evals/cases/*` — that marks them curated, and
 * `langfuse:sync-datasets` migrates exactly those.
 *
 * Read-only: no Langfuse / DB writes. Only calls the triage model.
 *
 * Usage: `bun run langfuse:triage-cases` (needs OPENROUTER_API_KEY).
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import { allSuites } from "../evals/cases";
import type { Assertion, EvalCase } from "../evals/types";

const MODEL =
  process.env.OPENROUTER_TRIAGE_MODEL ??
  process.env.OPENROUTER_EVAL_JUDGE_MODEL ??
  "google/gemini-3.6-flash";

const CONCURRENCY = 5;

const TriageSchema = z.object({
  capability: z.enum([
    "extraction",
    "generation",
    "external-actions",
    "reasoning",
  ]),
  promptClarity: z.number().min(0).max(5),
  rubricClarity: z.number().min(0).max(5),
  regressionValue: z.number().min(0).max(5),
  verdict: z.enum(["keep", "rewrite", "drop"]),
  reason: z.string(),
  suggestedRewrite: z
    .object({ prompt: z.string(), rubric: z.string() })
    .nullable(),
});

type Triage = z.infer<typeof TriageSchema>;

interface Row extends Triage {
  caseId: string;
  suite: string;
  description: string;
}

const SYSTEM = `Triage one eval case for an LLM chatbot regression suite. The cases were authored in a session, NOT from real production usage — so lean toward "rewrite" or "drop" and reserve "keep" for cases that already read like a real user's request with a sharp, unambiguous rubric.

Score 0-5 each:
- promptClarity: is the user prompt realistic and unambiguous?
- rubricClarity: are the judge rubric / assertions sharp and non-gameable?
- regressionValue: would failing this case signal a real quality regression worth blocking?

capability (pick one):
- extraction — pulling fields/values from documents, OCR, tables.
- generation — writing text, summaries, files, answers.
- external-actions — tool calls with side effects (SQL, web, email, code execution, memory writes).
- reasoning — multi-step planning, disambiguation, routing, refusals.

verdict:
- keep — realistic prompt + sharp rubric, high regression value, as-is.
- rewrite — useful intent but weak prompt/rubric; return suggestedRewrite with an improved prompt + a sharper rubric.
- drop — low value, redundant, or untestable.

For "rewrite" return suggestedRewrite; otherwise null.`;

const summariseAssertions = (assertions: Assertion[]): string =>
  assertions
    .map((a) => {
      switch (a.type) {
        case "judge":
          return `judge: ${a.rubric}`;
        case "contains":
          return `contains: ${a.value}`;
        case "regex":
          return `regex: ${a.value}`;
        case "toolUsed":
          return `toolUsed(${a.mode ?? "any"}): ${a.tools.join(", ")}`;
        case "toolNotUsed":
          return `toolNotUsed: ${a.tools.join(", ")}`;
        case "latencyUnder":
          return `latencyUnder: ${a.ms}ms`;
        case "noError":
          return "noError";
        case "custom":
          return `custom: ${a.name}`;
        default:
          return "";
      }
    })
    .join("\n");

const buildUserPrompt = (suite: string, c: EvalCase): string =>
  [
    `Suite: ${suite}`,
    `Case id: ${c.id}`,
    `Description: ${c.description}`,
    `Tags: ${(c.tags ?? []).join(", ") || "(none)"}`,
    `Fixtures: ${(c.fixtures ?? []).join(", ") || "(none)"}`,
    ``,
    `User prompt:`,
    c.prompt,
    ``,
    `Assertions:`,
    summariseAssertions(c.assertions),
  ].join("\n");

const pool = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) return;
      await fn(item, idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
};

const main = async (): Promise<void> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY env");
  const model = createOpenRouter({ apiKey }).chat(MODEL);

  const cases = allSuites.flatMap((s) =>
    s.cases.map((c) => ({ suite: s.name, case: c })),
  );
  console.log(`[triage] ${cases.length} cases via ${MODEL}`);

  const rows: Row[] = [];
  await pool(cases, CONCURRENCY, async ({ suite, case: c }) => {
    try {
      const { experimental_output: object } = await generateText({
        model,
        system: SYSTEM,
        prompt: buildUserPrompt(suite, c),
        temperature: 0,
        abortSignal: AbortSignal.timeout(40_000),
        experimental_output: Output.object({ schema: TriageSchema }),
      });
      rows.push({
        caseId: c.id,
        suite,
        description: c.description,
        ...object,
      });
      console.log(`  ${object.verdict.padEnd(7)} [${suite}/${c.id}]`);
    } catch (err) {
      console.warn(
        `  ERROR  [${suite}/${c.id}] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  rows.sort(
    (a, b) =>
      a.capability.localeCompare(b.capability) ||
      b.regressionValue - a.regressionValue,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `${import.meta.dir}/../evals/.triage`;
  const jsonPath = `${dir}/${stamp}.json`;
  await Bun.write(jsonPath, JSON.stringify(rows, null, 2));

  const counts = { keep: 0, rewrite: 0, drop: 0 };
  for (const r of rows) counts[r.verdict]++;

  const byCapability = (cap: string): Row[] =>
    rows.filter((r) => r.capability === cap);
  const capabilities = [
    "extraction",
    "generation",
    "external-actions",
    "reasoning",
  ];
  const lines: string[] = [
    `# Eval case triage — ${stamp}`,
    ``,
    `Model: ${MODEL} · ${rows.length} cases scored`,
    `keep=${counts.keep} · rewrite=${counts.rewrite} · drop=${counts.drop}`,
    ``,
    `Scores 0-5: P=promptClarity, R=rubricClarity, V=regressionValue.`,
    ``,
  ];
  for (const cap of capabilities) {
    const capRows = byCapability(cap);
    if (capRows.length === 0) continue;
    lines.push(`## ${cap} (${capRows.length})`, ``);
    lines.push(`| verdict | case | P | R | V | reason |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of capRows) {
      lines.push(
        `| ${r.verdict} | ${r.suite}/${r.caseId} | ${r.promptClarity} | ${r.rubricClarity} | ${r.regressionValue} | ${r.reason.replace(/\|/g, "/")} |`,
      );
    }
    lines.push(``);
  }
  const mdPath = `${dir}/${stamp}.md`;
  await Bun.write(mdPath, lines.join("\n"));

  console.log(
    `\n[triage] keep=${counts.keep} rewrite=${counts.rewrite} drop=${counts.drop}`,
  );
  console.log(`[triage] report: ${mdPath}`);
  console.log(`[triage] json:   ${jsonPath}`);
  console.log(
    `\nNEXT (human gate): review the report, then add 'capability' (+ 'smoke') to the cases you keep in evals/cases/*, and run 'bun run langfuse:sync-datasets'.`,
  );
  process.exit(0);
};

main().catch((err) => {
  console.error("[triage] fatal:", err);
  process.exit(1);
});
