import type { UIMessage } from "ai";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { boundProfile } from "../../lib/live-fleet";

/**
 * What happens between two turns when the summariser does not answer.
 *
 * This path is not hypothetical and it is not rare: measured on a workflow run
 * (2026-09-18), the summariser hit its 90-second timeout on 2 of 10 attempts.
 * Until now each of those cost a whole turn — `compactConversation` returned
 * the history untouched, and since the caller only ever reaches it when the
 * history is already over the cap, the request built from it was over the
 * ceiling too and the turn died at step zero having done nothing.
 *
 * The turn boundary already had a ladder for the identical problem. These pin
 * that between-turn compaction now uses the same one, and that it keeps the
 * same invariant: a compaction that does not reduce is refused rather than
 * applied.
 *
 * `summariseMessages` is mocked per test rather than shared — a mutable double
 * reused across files is how one suite's stub leaked into another's assertions
 * (`ai_unit_tests_sandbox_fixture_mocks`).
 */

/** A transcript with the two things the mechanical rung reproduces exactly. */
const transcript = (bulkChars: number): UIMessage[] => [
  {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "Je lance l'audit du premier lot." },
      {
        type: "tool-python",
        toolCallId: "c1",
        state: "output-available",
        input: { code: "print(open('/workspace/lot1.csv').read())" },
        output: {
          error: "ZeroDivisionError: division by zero",
          code: 1,
          stdout: "B-000001,operations,2025-03-14,1284.55,settled\n".repeat(
            Math.max(1, Math.floor(bulkChars / 48)),
          ),
        },
      },
    ],
  } as unknown as UIMessage,
];

/** A real derived profile — the threshold reads its window, nothing else. */
const profile = boundProfile("minimax-m3");

const loadCompact = async (summary: string | null) => {
  void mock.module("../../../src/services/compaction/summarizer", () => ({
    summariseMessages: () => Promise.resolve(summary),
    serialiseMessageBlocks: (messages: UIMessage[]) =>
      messages.map((m) => JSON.stringify(m)),
    parseSummariserMaxTokens: () => 20_000,
    summariseTranscript: () => Promise.resolve(summary),
    runSummariser: () => Promise.resolve(summary),
  }));
  return import("../../../src/services/compaction/compact");
};

afterEach(() => {
  mock.restore();
});

describe("compaction when the summariser does not answer", () => {
  test("falls back to a mechanical summary instead of the raw history", async () => {
    const { compactConversation } = await loadCompact(null);
    const messages = transcript(400_000);
    const out = await compactConversation(messages, {
      profile,
      maxThresholdTokens: 20_000,
    });

    // Not the input: something was folded.
    expect(out).not.toBe(messages);
    expect(out.length).toBeLessThanOrEqual(2);
    const text = JSON.stringify(out);
    // The one section a mechanical pass reproduces exactly, and the one that
    // decides whether the resumed agent converges or repeats itself.
    expect(text).toContain("ZeroDivisionError: division by zero");
    expect(text).toContain("python");
  });

  test("the fallback reduces, and says it was not the summariser", async () => {
    const { compactConversation } = await loadCompact(null);
    const messages = transcript(400_000);
    const out = await compactConversation(messages, {
      profile,
      maxThresholdTokens: 20_000,
    });
    expect(JSON.stringify(out).length).toBeLessThan(
      JSON.stringify(messages).length,
    );
    expect(JSON.stringify(out)).toContain("summariser was unavailable");
  });

  test("a summary that does not reduce is refused, not applied", async () => {
    // The invariant that makes the rung safe to add at all. A transcript small
    // enough that the mechanical scaffolding outweighs it must come back
    // untouched — no improvement, but never a swap for something larger.
    const { compactConversation } = await loadCompact(null);
    const small = transcript(200);
    const out = await compactConversation(small, {
      profile,
      maxThresholdTokens: 1,
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(
      JSON.stringify(small).length,
    );
  });

  test("a working summariser is still preferred", async () => {
    const { compactConversation } = await loadCompact(
      "Audit du lot 1 en cours ; la lecture Python a échoué.",
    );
    const out = await compactConversation(transcript(400_000), {
      profile,
      maxThresholdTokens: 20_000,
    });
    const text = JSON.stringify(out);
    expect(text).toContain("Audit du lot 1 en cours");
    expect(text).not.toContain("summariser was unavailable");
  });
});
