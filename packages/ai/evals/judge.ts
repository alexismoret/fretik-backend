/**
 * LLM-as-judge for the eval harness. Not a test file.
 *
 * Renders a GRADED verdict (`correct` / `partial` / `incorrect` →
 * score 1 / 0.5 / 0) against a per-case criterion, with a one-line
 * rationale. Graded (not binary PASS/FAIL) so the experiment baseline
 * gets PARTIAL CREDIT — a near-miss scores 0.5 instead of vanishing to
 * a hard fail, which is the signal that lets a change show measurable
 * progress.
 *
 * The grading instructions live in `evals/judge-rubric.md` (the single
 * source of truth, shared with the Langfuse managed evaluator seeded by
 * `scripts/seed-langfuse-eval-config.ts`). This module injects the
 * per-case criterion + the assistant's answer + tool outputs underneath.
 *
 * Deliberately independent of `src/lib/openrouter.ts` — that module
 * throws at import time when `OPENROUTER_CHAT_MODEL` / `_FALLBACK_MODEL`
 * are absent (production-chatbot contracts, not the judge's).
 *
 * Default model: `google/gemini-3.7-flash` via OpenRouter. A STRONG
 * model from a DIFFERENT family than the production chatbot (MiniMax
 * M2.7) — avoids the self-enhancement bias where a same-family judge
 * favours outputs it would have produced. Cheap at eval scale. Override
 * via `OPENROUTER_EVAL_JUDGE_MODEL`.
 *
 * Tool-output grounding: the judge sees every tool output (capped at
 * `JUDGE_TOOL_OUTPUT_CHARS` to bound token cost, not the old aggressive
 * 400-char preview that hid the data the rubric needed). Without this,
 * "numbers grounded on a querySql call" rubrics produce false positives.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const DEFAULT_JUDGE_MODEL =
  process.env.OPENROUTER_EVAL_JUDGE_MODEL ?? "google/gemini-3.7-flash";

const JUDGE_TIMEOUT_MS = 25_000;
const JUDGE_MAX_TOKENS = 400;
/**
 * High cap — preserves grounding while bounding judge token cost.
 * 12K (~3K tokens/output on Gemini Flash): resolved `<persisted-output>`
 * payloads (RAG results up to 48K) get real coverage — at 4K the judge
 * missed grounded chunks and graded them "fabricated" (2026-07-17).
 */
const JUDGE_TOOL_OUTPUT_CHARS = 12_000;

let cachedJudge: ReturnType<
  ReturnType<typeof createOpenRouter>["chat"]
> | null = null;

const getJudge = () => {
  if (cachedJudge) return cachedJudge;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY env");
  const client = createOpenRouter({ apiKey });
  cachedJudge = client.chat(DEFAULT_JUDGE_MODEL);
  return cachedJudge;
};

export type JudgeLabel = "correct" | "partial" | "incorrect";

export interface JudgeVerdict {
  label: JudgeLabel;
  /** 1 (correct) | 0.5 (partial) | 0 (incorrect). Partial credit. */
  score: number;
  rationale: string;
  /** Strict: only a full `correct` counts as a binary pass. */
  passed: boolean;
}

const SCORE_BY_LABEL: Record<JudgeLabel, number> = {
  correct: 1,
  partial: 0.5,
  incorrect: 0,
};

let cachedSystemPrompt: string | null = null;

const getSystemPrompt = async (): Promise<string> => {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  cachedSystemPrompt = (
    await Bun.file(`${import.meta.dir}/judge-rubric.md`).text()
  ).trim();
  return cachedSystemPrompt;
};

const STRICT_RETRY_SUFFIX = `

CRITICAL: your previous reply was malformed. Output LITERALLY one of CORRECT / PARTIAL / INCORRECT on line 1, then one short sentence on line 2. Nothing else.`;

const previewToolOutput = (output: unknown): string => {
  try {
    const serialised =
      typeof output === "string" ? output : JSON.stringify(output);
    if (serialised.length <= JUDGE_TOOL_OUTPUT_CHARS) return serialised;
    return `${serialised.slice(0, JUDGE_TOOL_OUTPUT_CHARS)}… [truncated ${serialised.length - JUDGE_TOOL_OUTPUT_CHARS} chars]`;
  } catch {
    return "(output not serialisable)";
  }
};

const buildUserPrompt = (args: {
  rubric: string;
  userPrompt: string;
  assistantOutput: string;
  toolCalls: { name: string; output: unknown }[];
}): string => {
  const toolSection =
    args.toolCalls.length === 0
      ? "No tools were called."
      : args.toolCalls
          .map(
            (c, i) =>
              `[${i + 1}] ${c.name}\n    output: ${previewToolOutput(c.output)}`,
          )
          .join("\n");
  return [
    `Criterion (grade against its SPIRIT, not word-for-word):`,
    args.rubric,
    ``,
    `User question:`,
    args.userPrompt,
    ``,
    `Tool outputs the assistant saw (use ONLY to check facts/numbers are grounded; do not require the answer to quote them verbatim):`,
    toolSection,
    ``,
    `Assistant's final answer:`,
    args.assistantOutput || "(empty — the assistant produced no text)",
  ].join("\n");
};

const parseVerdict = (text: string): JudgeVerdict | null => {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const label = lines[0]?.toLowerCase();
  const rationale = lines.slice(1).join(" ") || "(no rationale)";
  if (label === "correct" || label === "partial" || label === "incorrect") {
    return {
      label,
      score: SCORE_BY_LABEL[label],
      rationale,
      passed: label === "correct",
    };
  }
  return null;
};

const callJudge = async (
  system: string,
  userPrompt: string,
): Promise<string> => {
  const { text } = await generateText({
    model: getJudge(),
    system,
    prompt: userPrompt,
    temperature: 0,
    maxOutputTokens: JUDGE_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  return text;
};

const fail = (rationale: string): JudgeVerdict => ({
  label: "incorrect",
  score: 0,
  rationale,
  passed: false,
});

/**
 * Grade `assistantOutput` against `rubric`. Retries once with a stricter
 * reminder on malformed output. Returns an `incorrect` verdict on
 * timeout / double-malformed / throw so the suite always reports.
 */
export const judge = async (args: {
  rubric: string;
  userPrompt: string;
  assistantOutput: string;
  toolCalls: { name: string; output: unknown }[];
}): Promise<JudgeVerdict> => {
  const system = await getSystemPrompt();
  const userPrompt = buildUserPrompt(args);
  try {
    const first = await callJudge(system, userPrompt);
    const parsed = parseVerdict(first);
    if (parsed) return parsed;
    const second = await callJudge(
      `${system}${STRICT_RETRY_SUFFIX}`,
      userPrompt,
    );
    const retried = parseVerdict(second);
    if (retried) return retried;
    return fail(`Judge malformed twice. Last reply: ${second.slice(0, 200)}`);
  } catch (err) {
    return fail(
      `Judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
