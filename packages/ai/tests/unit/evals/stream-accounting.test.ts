import { describe, expect, test } from "bun:test";
import { absorbChunk, createStreamState } from "../../../evals/http-client";

/**
 * The eval client reconstructs a turn's tool calls from the SSE stream, and
 * those counts feed `tool-call-count`, `redundant-call-count` and
 * `tool-budget-overage` — three assertions that judge the MODEL.
 *
 * Measured 2026-08-22: `buildPage` streams progress, the SDK emits one
 * `tool-output-available` per yield under a single `toolCallId`, and every one
 * of them was counted. A run reported `buildPage×20` for ONE build, fired a
 * budget overage, and put the redundant-call rate at 0.625. Nothing errored —
 * the Langfuse trace held exactly 2 `buildPage` observations while the stream
 * claimed 10, so the two instruments disagreed with each other rather than
 * with reality.
 */

const inputAvailable = (toolCallId: string, toolName: string) => ({
  type: "tool-input-available",
  toolCallId,
  toolName,
  input: {},
});

const outputAvailable = (
  toolCallId: string,
  output: unknown,
  preliminary?: boolean,
) => ({
  type: "tool-output-available",
  toolCallId,
  output,
  ...(preliminary === undefined ? {} : { preliminary }),
});

describe("eval stream accounting — a progress yield is not a call", () => {
  test("a streaming tool counts ONCE however many snapshots it sends", () => {
    const state = createStreamState();
    absorbChunk(inputAvailable("call_1", "buildPage"), state);
    for (const step of [1, 2, 3, 4, 5]) {
      absorbChunk(
        outputAvailable(
          "call_1",
          { progress: { step, tool: "managePage" } },
          true,
        ),
        state,
      );
    }
    absorbChunk(
      outputAvailable("call_1", { summary: "done", pageId: "p1" }),
      state,
    );

    expect(state.toolCalls.length).toBe(1);
    expect(state.toolCalls[0]?.name).toBe("buildPage");
  });

  test("the counted output is the FINAL one, never a snapshot", () => {
    const state = createStreamState();
    absorbChunk(inputAvailable("call_1", "buildPage"), state);
    absorbChunk(
      outputAvailable(
        "call_1",
        { progress: { step: 1, tool: "managePage" } },
        true,
      ),
      state,
    );
    absorbChunk(
      outputAvailable("call_1", { summary: "done", pageId: "p1" }),
      state,
    );

    // Assertions downstream read this output for the page id; a snapshot here
    // would make a finished build look like "step 1".
    expect(state.toolCalls[0]?.output).toEqual({
      summary: "done",
      pageId: "p1",
    });
  });

  test("an ordinary tool is unaffected — one output, one call", () => {
    const state = createStreamState();
    absorbChunk(inputAvailable("call_1", "querySql"), state);
    absorbChunk(outputAvailable("call_1", { rows: [] }), state);
    absorbChunk(inputAvailable("call_2", "describeCollection"), state);
    absorbChunk(outputAvailable("call_2", { fields: [] }), state);

    expect(state.toolCalls.map((c) => c.name)).toEqual([
      "querySql",
      "describeCollection",
    ]);
  });

  test("a build that ends with only snapshots counts as a call that returned nothing", () => {
    const state = createStreamState();
    absorbChunk(inputAvailable("call_1", "buildPage"), state);
    absorbChunk(
      outputAvailable(
        "call_1",
        { progress: { step: 1, tool: "managePage" } },
        true,
      ),
      state,
    );
    // No final output — the stream was cut. Counting zero calls here would
    // hide a build that ran and produced nothing, which is exactly the
    // failure the suite has to be able to see.
    expect(state.toolCalls.length).toBe(0);
    expect(state.toolInputs.has("call_1")).toBe(true);
  });
});

/**
 * The turn's price rides the same finish frame as its trace id.
 *
 * This is what `cost-agent-usd` reads now. It replaced summing the trace's
 * Langfuse observations, which reported $129.50 for $5.89 of real traffic on
 * 2026-09-05 and gave nobody a way to notice.
 */
describe("what the turn says it spent", () => {
  const finishWith = (telemetry: unknown) => ({
    type: "finish",
    messageMetadata: { langfuseTraceId: "trace-1", telemetry },
  });

  test("the server's ledger is read off the finish frame", () => {
    const state = createStreamState();
    absorbChunk(
      finishWith({
        usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
        spend: {
          total: { steps: 34, costedSteps: 34, costUsd: 0.7912 },
          byAgent: {
            chatbot: { steps: 4, costUsd: 0.0412 },
            "chatbot.page-builder": { steps: 30, costUsd: 0.75 },
          },
        },
      }),
      state,
    );

    expect(state.spend?.costUsd).toBe(0.7912);
    expect(state.spend?.steps).toBe(34);
    // The page's own price is the builder's bucket, not the turn's total: the
    // parent's four steps are not part of what the page cost.
    expect(state.spend?.byAgent?.["chatbot.page-builder"]?.costUsd).toBe(0.75);
    // The parent stream's own token counts still travel, unchanged.
    expect(state.usage?.totalTokens).toBe(940);
  });

  test("a service that sends no ledger leaves it undefined, not zero", () => {
    // Zero would be scored as a free run. Undefined is what makes the runner
    // fall back to the Langfuse sum instead.
    const state = createStreamState();
    absorbChunk(
      finishWith({ usage: { inputTokens: 900, outputTokens: 40 } }),
      state,
    );

    expect(state.spend).toBeUndefined();
    expect(state.traceId).toBe("trace-1");
  });
});
