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
    case "toolCallsUnder": {
      const used = result.toolCalls.length;
      const passed = used <= assertion.max;
      // Names the worst offender, because a runaway is always one tool: the
      // number alone sends a reader back to the trace to learn which.
      const tally = new Map<string, number>();
      for (const call of result.toolCalls) {
        tally.set(call.name, (tally.get(call.name) ?? 0) + 1);
      }
      const worst = [...tally].sort((a, b) => b[1] - a[1])[0];
      return {
        type: "toolCallsUnder",
        label: `tool calls <= ${assertion.max}`,
        passed,
        score: passed ? 1 : 0,
        message: passed
          ? undefined
          : `${used} tool calls${worst ? ` (${worst[1]}× ${worst[0]})` : ""}`,
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
      // A turn that ends on `askUserQuestion` shows the user a question CARD,
      // carried in that call's INPUT — and the harness only forwards tool
      // outputs, so without this the judge grades an answer the user never saw
      // in full.
      //
      // It applies whether or not there is prose, and that second half was a
      // real defect: `obj-sync-workflow-reads-collection` answered "I'll set up
      // the automation that runs every morning at 8, one question before I
      // build it:" and then asked it on the card. The judge saw the sentence
      // stop at the colon and marked the case as never having proposed a plan
      // (2026-09-20). Half an answer grades worse than none, because it reads
      // as an answer.
      //
      // Whether clarifying was the right move stays the rubric's call.
      const lastCall = result.toolCalls[result.toolCalls.length - 1];
      const hasProse = result.text.trim().length > 0;
      const askCardAnswer =
        lastCall?.name === "askUserQuestion"
          ? `${hasProse ? result.text : "(no prose)"}\n\n(the assistant ended the turn by showing the user this question card): ${JSON.stringify(lastCall.input)}`
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
      // A graded verdict carries its own score; the message is kept whether it
      // passed or not, because the number is what the baseline compares.
      if (typeof verdict === "object") {
        return {
          type: "custom",
          label: `custom: ${assertion.name}`,
          passed: verdict.passed,
          score: Math.min(1, Math.max(0, verdict.score)),
          message: verdict.message,
        };
      }
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
