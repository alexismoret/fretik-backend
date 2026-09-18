import type { ModelMessage } from "ai";
import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * A boundary that does not reduce is not a boundary.
 *
 * This is the failure Claude Code has open and unresolved (#26220, #26317,
 * #30401): at the context limit, auto-compaction, `/compact` and rewind fail
 * TOGETHER, because all three need a model call and there is no room left to
 * make one. The remedies proposed on those issues are the two rungs below the
 * summariser — "a fallback compaction strategy like aggressive truncation" —
 * and the headroom that makes the first rung reachable at all.
 *
 * Our ceiling fires at an absolute 100 000 rather than at ~95 % of the window,
 * so the summariser always has room. These tests cover what happens when it
 * fails anyway.
 *
 * `summariseTranscript` is mocked per test rather than shared: a mutable
 * double reused across files is how one suite's stub leaked into another's
 * assertions (`ai_unit_tests_sandbox_fixture_mocks`).
 */

const bigTurn = (chars: number): ModelMessage[] => [
  { role: "assistant", content: "A".repeat(chars) },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "python",
        input: { code: "print(1)" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "python",
        output: {
          type: "json",
          value: { error: "ZeroDivisionError: division by zero", code: 1 },
        },
      },
    ],
  },
];

const loadBoundary = async (summary: string | null) => {
  // `mock.module` returns a promise under Bun's types; the registration is
  // synchronous and the import below is what has to wait, not this.
  void mock.module("../../../src/services/compaction/summarizer", () => ({
    summariseTranscript: () => Promise.resolve(summary),
    parseSummariserMaxTokens: () => 20_000,
    summariseMessages: () => Promise.resolve(summary),
    runSummariser: () => Promise.resolve(summary),
    serialiseMessageBlocks: () => [],
  }));
  return import("../../../src/services/compaction/turn-boundary");
};

afterEach(() => {
  mock.restore();
});

describe("the boundary ladder", () => {
  test("rung 1: a good summary is taken, and says so", async () => {
    const { buildTurnBoundaryResume } = await loadBoundary("Short summary.");
    const resume = await buildTurnBoundaryResume({
      messages: bigTurn(60_000),
      teamId: undefined,
      logPrefix: "[test]",
    });
    expect(resume?.kind).toBe("llm");
    expect(resume?.charsAfter).toBeLessThan(resume?.charsBefore ?? 0);
  });

  test("rung 2: the summariser fails and a mechanical summary takes over", async () => {
    const { buildTurnBoundaryResume } = await loadBoundary(null);
    const resume = await buildTurnBoundaryResume({
      messages: bigTurn(60_000),
      teamId: undefined,
      logPrefix: "[test]",
    });
    expect(resume?.kind).toBe("mechanical");
    // The one section a mechanical pass can reproduce exactly, and the one
    // that decides whether the resumed agent converges or repeats itself.
    expect(resume?.message.content).toContain(
      "ZeroDivisionError: division by zero",
    );
    expect(resume?.message.content).toContain("python");
  });

  test("rung 2 respects the reduction invariant", async () => {
    const { buildTurnBoundaryResume, BOUNDARY_MAX_RATIO } =
      await loadBoundary(null);
    const resume = await buildTurnBoundaryResume({
      messages: bigTurn(200_000),
      teamId: undefined,
      logPrefix: "[test]",
    });
    expect(resume).not.toBeNull();
    expect(resume?.charsAfter).toBeLessThanOrEqual(
      (resume?.charsBefore ?? 0) * BOUNDARY_MAX_RATIO,
    );
  });

  test("rung 3: truncation catches what the mechanical pass cannot fit", async () => {
    // A run that failed in many DIFFERENT ways: the mechanical summary's own
    // scaffolding — every distinct error verbatim, every path touched — is
    // then larger than half the transcript it is summarising, so the rung is
    // rejected by its own invariant and truncation takes over. This is the
    // shape that makes the third rung necessary rather than decorative.
    const { buildTurnBoundaryResume } = await loadBoundary("Z".repeat(500_000));
    const messages: ModelMessage[] = Array.from({ length: 24 }, (_, i) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: `c${i.toString()}`,
          toolName: "bash",
          output: {
            type: "json" as const,
            value: {
              error: `E${i.toString()}: ${"distinct failure text ".repeat(6)}`,
              code: i,
              path: `/workspace/outputs/report-${i.toString()}.csv`,
            },
          },
        },
      ],
    }));
    const resume = await buildTurnBoundaryResume({
      messages,
      teamId: undefined,
      logPrefix: "[test]",
    });
    expect(resume?.kind).toBe("truncated");
    expect(resume?.charsAfter).toBeLessThan(resume?.charsBefore ?? 0);
  });

  test("an empty turn yields no boundary at all", async () => {
    const { buildTurnBoundaryResume } = await loadBoundary("summary");
    expect(
      await buildTurnBoundaryResume({
        messages: [],
        teamId: undefined,
        logPrefix: "[test]",
      }),
    ).toBeNull();
  });

  test("a turn too small to halve gets no boundary, not a bad one", async () => {
    // The honest answer when every rung is above the ratio: the caller keeps
    // what it had and ends the turn. That is bounded; looping on a boundary
    // that did not reduce is not.
    const { buildTurnBoundaryResume } = await loadBoundary("summary");
    const resume = await buildTurnBoundaryResume({
      messages: [{ role: "assistant", content: "tiny" }],
      teamId: undefined,
      logPrefix: "[test]",
    });
    expect(resume).toBeNull();
  });
});
