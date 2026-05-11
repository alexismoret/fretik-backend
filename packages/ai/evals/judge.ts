/**
 * LLM-as-judge for the eval harness. Not a test file.
 *
 * Renders a binary PASS/FAIL verdict against a rubric, with a one-line
 * rationale. Deliberately independent of `src/lib/openrouter.ts` —
 * that module throws at import time when `OPENROUTER_CHAT_MODEL` and
 * `OPENROUTER_FALLBACK_MODEL` are absent (they're contracts for the
 * production chatbot, not the judge).
 *
 * Default model: `deepseek/deepseek-v3.2` (~$0.26/$0.41 per MTok).
 * Rationale:
 *   1. Different family than the production chatbot (MiniMax M2.7) —
 *      avoids the self-evaluation bias where a judge from the same
 *      model family unconsciously favours outputs it would have
 *      produced itself. Classic LLM-as-judge pitfall.
 *   2. Strong instruction-following — the original gpt-oss-120b
 *      occasionally forgot its grader role and answered the user's
 *      question instead of producing PASS/FAIL (observed 2/30 times
 *      in the Phase 10 baseline). DeepSeek V3.2 holds format better.
 *   3. Cheap at eval scale (~$0.01 per 30-case run) — cost is not a
 *      driver vs judge quality.
 *
 * Override via `OPENROUTER_EVAL_JUDGE_MODEL` if you want to swap in
 * Claude Sonnet, GPT-4o, etc. Rubric-based judging generalises across
 * model families.
 *
 * Rubric contract: phrase pass criteria positively. The judge replies
 * `PASS` or `FAIL` on line 1 + a one-line justification on line 2.
 * Anything else triggers a single retry with a stronger reminder; if
 * the retry also returns malformed, the verdict is FAIL with the raw
 * response as the rationale (so you can see why the judge misbehaved
 * and fix the rubric).
 *
 * Tool-output grounding: the judge receives a TRUNCATED summary of
 * every tool output (first 400 chars JSON-stringified) in addition to
 * the assistant's final text. Without this, rubrics like "the answer
 * gives numbers grounded on a querySql call" produce false positives
 * because the judge can't see whether the numbers came from the tool
 * or were fabricated.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const DEFAULT_JUDGE_MODEL =
  process.env.OPENROUTER_EVAL_JUDGE_MODEL ?? "deepseek/deepseek-v3.2";

const JUDGE_TIMEOUT_MS = 25_000;
const JUDGE_MAX_TOKENS = 400;
const TOOL_OUTPUT_PREVIEW_CHARS = 400;

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

export interface JudgeVerdict {
  passed: boolean;
  rationale: string;
}

const SYSTEM_PROMPT = `You are a grader evaluating an AI assistant's output against a rubric.

## Output format — strict
Exactly two lines, nothing more:
  Line 1: PASS or FAIL (uppercase, no punctuation, no markdown).
  Line 2: a single short sentence (≤ 25 words) explaining the verdict.

Never answer the user's question. Never produce markdown, tables, code blocks, or multi-paragraph text. You are ONLY grading.

## Grading philosophy — charitable
Apply CHARITABLE interpretation of the rubric. Rubrics describe the SPIRIT of what a good answer looks like, not a precise specification. PASS when the answer honours the rubric's intent; FAIL only when the answer clearly violates it.

Rules of thumb:
- If the rubric says "2-3 options", accept 1-5 options.
- If the rubric says "cite a document", accept any clear reference (name, link, quoted fragment, page number). Do NOT require verbatim quotation unless the rubric literally uses the word "verbatim".
- If the rubric says "introduce itself as Fretik's transport/logistics assistant or equivalent", accept any greeting that tells the user what the assistant does.
- If the rubric says "list at most N items", accept a table or free-text list with N items (extra columns or formatting are fine).
- If the rubric has multiple clauses joined by "and", all must hold. If joined by "or", any one is enough.
- Minor deviations in wording, ordering, extra helpful content, or presentation format → PASS.
- Factual errors, invented data not in the tool outputs, contradictions of user intent, refusal to address the question → FAIL.

## Tool outputs
The prompt includes the raw (truncated) outputs of every tool the assistant called. Use them ONLY to check whether the assistant's numbers/names/facts are grounded. Do NOT expect the final answer to echo them verbatim — the assistant may summarise, translate status labels ("processing" → "En cours"), reformat, or omit noise. Translation/labelling choices are PASS as long as the underlying data is consistent.

If the tool output list is empty and the rubric accepts that path (e.g. "or states the dataset is empty"), PASS when the assistant honestly reports "no data" / "none found".

### Fuzzy matches ≠ presence — CRITICAL
Search tools (searchKnowledge / RAG) return SEMANTICALLY similar results, not exact matches. When the user asks about a specific identifier / filename / ID (e.g. "BL-2024-0342", "dossier-inexistant-xyz.pdf", "Mars delivery") and the tool outputs contain DIFFERENT content that shares some tokens or is topically related (e.g. a document named "UATG-260402G012284" returned because it contains "BL" and "2024" as tokens; a document about "Maurice" returned because "Mars" shares letters), the assistant's "no match found" / "this document does not exist" answer is CORRECT. PASS it.

FAIL only when the assistant invents content — e.g. "according to your contract, payment terms are Net 30" when no such text exists in any tool output. Merely noting what the search returned and explaining why it doesn't answer the question is NOT fabrication — it is transparent reporting and should PASS.

## When in doubt
If you hesitate between PASS and FAIL, default to PASS. Eval rubrics are guidelines — a borderline answer the assistant got mostly right is PASS.`;

const SYSTEM_PROMPT_STRICT_RETRY = `${SYSTEM_PROMPT}

CRITICAL: your previous reply was malformed. Output LITERALLY:

PASS
<one short sentence>

or

FAIL
<one short sentence>

Nothing else. No greeting. No apology. No headers. No markdown.`;

const previewToolOutput = (output: unknown): string => {
  try {
    const serialised =
      typeof output === "string" ? output : JSON.stringify(output);
    if (serialised.length <= TOOL_OUTPUT_PREVIEW_CHARS) return serialised;
    return `${serialised.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)}… [truncated ${serialised.length - TOOL_OUTPUT_PREVIEW_CHARS} chars]`;
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
    `Rubric (evaluate against the SPIRIT of this, not word-for-word):`,
    args.rubric,
    ``,
    `User question:`,
    args.userPrompt,
    ``,
    `Tool outputs the assistant saw (truncated to ${TOOL_OUTPUT_PREVIEW_CHARS} chars). Use ONLY to check the assistant's facts/numbers are grounded; do NOT require the final answer to quote them verbatim or preserve their exact wording:`,
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
  const verdict = lines[0]?.toUpperCase();
  const rationale = lines.slice(1).join(" ") || "(no rationale)";
  if (verdict === "PASS") return { passed: true, rationale };
  if (verdict === "FAIL") return { passed: false, rationale };
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

/**
 * Ask the judge whether `assistantOutput` satisfies `rubric`.
 * Retries once with a stricter reminder on malformed responses.
 * Returns `{ passed: false, rationale }` on timeout / double-
 * malformed / throw so the suite always reports a verdict.
 */
export const judge = async (args: {
  rubric: string;
  userPrompt: string;
  assistantOutput: string;
  toolCalls: { name: string; output: unknown }[];
}): Promise<JudgeVerdict> => {
  const userPrompt = buildUserPrompt(args);
  try {
    const first = await callJudge(SYSTEM_PROMPT, userPrompt);
    const parsed = parseVerdict(first);
    if (parsed) return parsed;
    // Retry once with the stricter reminder. Second malformed = FAIL.
    const second = await callJudge(SYSTEM_PROMPT_STRICT_RETRY, userPrompt);
    const retried = parseVerdict(second);
    if (retried) return retried;
    return {
      passed: false,
      rationale: `Judge malformed twice. Last reply: ${second.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      passed: false,
      rationale: `Judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
