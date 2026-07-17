/**
 * Assertion engine for the eval harness. Not a test file.
 *
 * Takes an `InvokeResult` (from `http-client.ts`) and an ordered list
 * of `Assertion`s (from `types.ts`), returning one `AssertionResult`
 * per assertion. Each assertion is independent — a failing assertion
 * never short-circuits the rest, so the report always shows every
 * expectation's state.
 *
 * The only assertion that fires an LLM call is `judge` (delegated to
 * `./judge.ts`). Every other type is pure, deterministic, local.
 */

import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import { judge } from "./judge";
import type {
  Assertion,
  AssertionResult,
  EvalCaseContext,
  InvokeResult,
} from "./types";

const PERSISTED_PATH_RE = /Full output saved to: (\S+)/;

/**
 * Resolve a `<persisted-output>` envelope back to its stored payload so
 * the judge grades against the evidence the assistant actually read.
 * The envelope only carries a 2K preview — grading on it alone made the
 * judge flag GROUNDED facts as fabricated (dbg-4 `doc-rag-first-content`,
 * 2026-07-17: the charte + sea-waybill chunks lived in the persisted
 * file). Falls back to the raw envelope on any miss.
 */
const resolvePersistedOutput = async (
  output: unknown,
  conversationId: string,
): Promise<unknown> => {
  if (
    typeof output !== "string" ||
    !output.includes("<persisted-output>") ||
    conversationId.length === 0
  ) {
    return output;
  }
  const path = PERSISTED_PATH_RE.exec(output)?.[1];
  if (!path) return output;
  try {
    const bytes = await readSessionFile(conversationId, path);
    if (bytes === null) return output;
    return new TextDecoder().decode(bytes);
  } catch {
    return output;
  }
};

const runOne = async (
  assertion: Assertion,
  result: InvokeResult,
  prompt: string,
  ctx: EvalCaseContext,
): Promise<AssertionResult> => {
  switch (assertion.type) {
    case "contains": {
      const hay = assertion.caseInsensitive
        ? result.text.toLowerCase()
        : result.text;
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const passed = hay.includes(needle);
      return {
        type: "contains",
        label: `contains "${assertion.value}"${assertion.caseInsensitive ? " (ci)" : ""}`,
        passed,
        score: passed ? 1 : 0,
        message: passed
          ? undefined
          : `text did not contain the expected fragment`,
      };
    }
    case "regex": {
      const re = new RegExp(assertion.value, assertion.flags);
      const passed = re.test(result.text);
      return {
        type: "regex",
        label: `matches /${assertion.value}/${assertion.flags ?? ""}`,
        passed,
        score: passed ? 1 : 0,
        message: passed ? undefined : `regex did not match assistant text`,
      };
    }
    case "toolUsed": {
      const toolsUsed = new Set(result.toolCalls.map((c) => c.name));
      const mode = assertion.mode ?? "any";
      const passed =
        mode === "all"
          ? assertion.tools.every((t) => toolsUsed.has(t))
          : assertion.tools.some((t) => toolsUsed.has(t));
      return {
        type: "toolUsed",
        label: `${mode === "all" ? "all of" : "any of"} [${assertion.tools.join(", ")}]`,
        passed,
        score: passed ? 1 : 0,
        message: passed
          ? undefined
          : `tools used: [${[...toolsUsed].join(", ") || "none"}]`,
      };
    }
    case "toolNotUsed": {
      const toolsUsed = new Set(result.toolCalls.map((c) => c.name));
      const leaked = assertion.tools.filter((t) => toolsUsed.has(t));
      const passed = leaked.length === 0;
      return {
        type: "toolNotUsed",
        label: `none of [${assertion.tools.join(", ")}]`,
        passed,
        score: passed ? 1 : 0,
        message: passed
          ? undefined
          : `unexpected tools called: [${leaked.join(", ")}]`,
      };
    }
    case "latencyUnder": {
      const passed = result.latencyMs < assertion.ms;
      return {
        type: "latencyUnder",
        label: `latency < ${assertion.ms}ms`,
        passed,
        score: passed ? 1 : 0,
        message: passed ? undefined : `latency was ${result.latencyMs}ms`,
      };
    }
    case "noError": {
      const errorish =
        Boolean(result.error) ||
        result.finishReason === "error" ||
        (result.httpStatus !== undefined && result.httpStatus >= 400);
      return {
        type: "noError",
        label: "no error",
        passed: !errorish,
        score: errorish ? 0 : 1,
        message: errorish
          ? `error=${result.error ?? "(none)"} finish=${result.finishReason ?? "?"} status=${result.httpStatus ?? "?"}`
          : undefined,
      };
    }
    case "judge": {
      // A turn that ends on `askUserQuestion` has empty text BY DESIGN —
      // the user-visible product is the question card, carried in that
      // call's INPUT (the harness only forwards outputs). Surface it as
      // the final answer so the judge grades what the user actually saw;
      // whether clarifying was the right move stays the rubric's call.
      const lastCall = result.toolCalls[result.toolCalls.length - 1];
      const askCardAnswer =
        result.text.trim().length === 0 && lastCall?.name === "askUserQuestion"
          ? `(no prose — the assistant ended the turn by showing the user this question card): ${JSON.stringify(lastCall.input)}`
          : undefined;
      const judgeToolCalls = await Promise.all(
        result.toolCalls.map(async (c) => ({
          name: c.name,
          output: await resolvePersistedOutput(c.output, ctx.conversationId),
        })),
      );
      const verdict = await judge({
        rubric: assertion.rubric,
        userPrompt: prompt,
        assistantOutput: askCardAnswer ?? result.text,
        toolCalls: judgeToolCalls,
      });
      const expected = assertion.expectPass ?? true;
      const passed = verdict.passed === expected;
      // `score` = how well the assertion's EXPECTATION was met. For a
      // negative assertion (`expectPass: false`) invert the judge's
      // partial-credit score so incorrect→1, correct→0, partial→0.5.
      const score = expected ? verdict.score : 1 - verdict.score;
      return {
        type: "judge",
        label: `llm-judge: "${assertion.rubric.slice(0, 60)}${assertion.rubric.length > 60 ? "…" : ""}"`,
        passed,
        score,
        message: verdict.rationale,
      };
    }
    case "custom": {
      // `custom.fn` may be sync or async — `await` accepts both.
      const verdict = await assertion.fn(result, ctx);
      const passed = verdict === true;
      return {
        type: "custom",
        label: `custom: ${assertion.name}`,
        passed,
        score: passed ? 1 : 0,
        message:
          typeof verdict === "string" && !passed
            ? verdict
            : passed
              ? undefined
              : "custom assertion returned false",
      };
    }
  }
  // Unreachable — the switch above is exhaustive over the `Assertion`
  // discriminated union. Kept as an explicit `never` return so the
  // linter sees every path producing an `AssertionResult`.
  throw new Error(
    `Unhandled assertion type: ${(assertion as { type: string }).type}`,
  );
};

export const runAssertions = async (
  assertions: Assertion[],
  result: InvokeResult,
  prompt: string,
  ctx: EvalCaseContext,
): Promise<AssertionResult[]> =>
  Promise.all(assertions.map((a) => runOne(a, result, prompt, ctx)));
