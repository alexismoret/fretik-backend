import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import {
  FAILOVER_SENTINEL,
  NON_TERMINAL_STEP_ERROR,
  TOOL_INPUT_RETRY_NOTICE,
  USER_STOP_NOTICE,
} from "../../../src/lib/stream-errors";
import { dropNonTerminalErrorFrames } from "../../../src/lib/wire-errors";

/**
 * What this guards: since ai@7.0.85 the client's `Chat` consumes the UI
 * stream through `processUIMessageStream({ onError: (e) => { throw e } })`,
 * so ANY `error` chunk stops it reading the turn. The four texts below are
 * notices, not deaths — a turn that carries one keeps producing — so letting
 * them reach the wire froze a live turn in the browser.
 *
 * The assertion that matters is therefore the DROP, not the pass-through: a
 * test that only checked "structured errors survive" is green on a transform
 * that forwards everything.
 */

const errorChunk = (errorText: string): UIMessageChunk => ({
  type: "error",
  errorText,
});

const drain = async (
  chunks: UIMessageChunk[],
): Promise<readonly UIMessageChunk[]> => {
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const out: UIMessageChunk[] = [];
  for await (const chunk of source.pipeThrough(dropNonTerminalErrorFrames())) {
    out.push(chunk);
  }
  return out;
};

describe("dropNonTerminalErrorFrames", () => {
  test.each([
    ["transparent failover sentinel", FAILOVER_SENTINEL],
    ["non-terminal step error", NON_TERMINAL_STEP_ERROR],
    ["tool-input retry notice", TOOL_INPUT_RETRY_NOTICE],
    ["user stop notice", USER_STOP_NOTICE],
  ])("drops the %s", async (_label, errorText) => {
    expect(await drain([errorChunk(errorText)])).toEqual([]);
  });

  test("a structured (terminal) error frame still reaches the wire", async () => {
    // The turn really is dead here — the client must see it and offer retry.
    const terminal = errorChunk(
      JSON.stringify({
        retryable: false,
        code: "unknown",
        message: "The model could not complete this turn.",
        resume: true,
      }),
    );
    expect(await drain([terminal])).toEqual([terminal]);
  });

  test("an unrecognised error text is NOT swallowed", async () => {
    // Fail loud: an error we cannot place is a death until proven otherwise.
    const unknown = errorChunk("something we have never seen");
    expect(await drain([unknown])).toEqual([unknown]);
  });

  test("non-error chunks pass through untouched, in order", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello" },
      errorChunk(NON_TERMINAL_STEP_ERROR),
      { type: "text-delta", id: "t1", delta: " world" },
      { type: "text-end", id: "t1" },
      { type: "finish" },
    ];
    // The surviving frames are exactly the input minus the notice — this is
    // the shape of the prod incident: a step hiccup between two text deltas
    // of a turn that went on to answer.
    expect(await drain(chunks)).toEqual([
      ...chunks.slice(0, 3),
      ...chunks.slice(4),
    ]);
  });
});
