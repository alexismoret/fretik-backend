import { describe, expect, test } from "bun:test";
import { createStepClock } from "../../../src/handlers/turn-helpers";

/**
 * The time a step row prints is the span the transcript drew it as running:
 * from the first character of the call to its result. Anything else — a clock
 * started at `tool-call` while the model had been writing a long script for
 * ten seconds, or stopped by a preliminary progress yield — shows the reader a
 * number that disagrees with what they watched.
 *
 * The clock is driven by a fake `now` so each case states its own times.
 */

// The clock reads a part's type and its call id — nothing else of the SDK's
// shape — so each case hands it just those.
const part = <T extends { type: string }>(fields: T): T => fields;

const clockAt = (times: number[]) => {
  let i = 0;
  return createStepClock(() => times[Math.min(i++, times.length - 1)] ?? 0);
};

describe("createStepClock", () => {
  test("times a call from its first input to its result", () => {
    const clock = clockAt([1_000, 3_400]);
    expect(
      clock(part({ type: "tool-input-start", id: "a", toolName: "python" })),
    ).toBeUndefined();
    expect(
      clock(part({ type: "tool-call", toolCallId: "a", toolName: "python" })),
    ).toBeUndefined();
    expect(
      clock(part({ type: "tool-result", toolCallId: "a", toolName: "python" })),
    ).toEqual({ stepDurations: { a: 2_400 } });
  });

  test("a call that arrives whole starts its clock at the call", () => {
    const clock = clockAt([500, 800]);
    clock(part({ type: "tool-call", toolCallId: "b", toolName: "read" }));
    expect(
      clock(part({ type: "tool-result", toolCallId: "b", toolName: "read" })),
    ).toEqual({ stepDurations: { b: 300 } });
  });

  test("a preliminary result is progress, not the end", () => {
    const clock = clockAt([0, 5_000]);
    clock(part({ type: "tool-input-start", id: "c", toolName: "buildPage" }));
    expect(
      clock(
        part({
          type: "tool-result",
          toolCallId: "c",
          toolName: "buildPage",
          preliminary: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      clock(
        part({ type: "tool-result", toolCallId: "c", toolName: "buildPage" }),
      ),
    ).toEqual({ stepDurations: { c: 5_000 } });
  });

  test("an error or a refusal settles the call too", () => {
    const clock = clockAt([0, 1_200, 2_000, 2_500]);
    clock(part({ type: "tool-input-start", id: "d", toolName: "searchWeb" }));
    expect(
      clock(
        part({ type: "tool-error", toolCallId: "d", toolName: "searchWeb" }),
      ),
    ).toEqual({ stepDurations: { d: 1_200 } });
    clock(
      part({ type: "tool-input-start", id: "e", toolName: "manageRecord" }),
    );
    expect(
      clock(
        part({
          type: "tool-output-denied",
          toolCallId: "e",
          toolName: "manageRecord",
        }),
      ),
    ).toEqual({ stepDurations: { e: 500 } });
  });

  test("says nothing about a call it never saw start, nor twice about one", () => {
    const clock = clockAt([0, 100, 200]);
    expect(
      clock(part({ type: "tool-result", toolCallId: "x", toolName: "read" })),
    ).toBeUndefined();
    clock(part({ type: "tool-input-start", id: "f", toolName: "read" }));
    clock(part({ type: "tool-result", toolCallId: "f", toolName: "read" }));
    expect(
      clock(part({ type: "tool-result", toolCallId: "f", toolName: "read" })),
    ).toBeUndefined();
  });

  test("ignores everything that is not a tool call's life", () => {
    const clock = clockAt([0]);
    expect(clock(part({ type: "start" }))).toBeUndefined();
    expect(
      clock(part({ type: "text-delta", id: "t", text: "hi" })),
    ).toBeUndefined();
    expect(clock(part({ type: "reasoning-start", id: "r" }))).toBeUndefined();
  });
});
