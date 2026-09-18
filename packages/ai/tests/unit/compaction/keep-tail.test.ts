import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { boundProfile } from "../../lib/live-fleet";
import { mockModule } from "../../lib/mock-module";

/**
 * What a compaction leaves alone.
 *
 * Until now it left nothing: the whole window became one summary message, so
 * the exchange the user was in the middle of came back as prose. A summary
 * represents old exchanges well — the outcome is what mattered about them — and
 * represents the newest one badly, because there the exact number, path and
 * wording ARE the content. Anthropic's context editing and Gemini CLI both keep
 * a tail, for that reason.
 *
 * Three things have to hold together, and each fails silently on its own:
 *  - the summariser sees the HEAD only, or the tail is described AND repeated;
 *  - the tail comes back LAST and unmodified, or the model reads a summary
 *    after the messages it summarises;
 *  - the tail is bounded by a fraction of the threshold, or a conversation
 *    compacts on every turn forever — the tail carries it straight back over.
 *
 * `mockModule` rather than a hand-listed `mock.module` factory: `compact.ts`
 * reaches `summarizer.ts` twice, directly and through `turn-boundary.ts`, so a
 * factory naming only the export this file stubs deletes `summariseTranscript`
 * and takes the boundary suite down at link time — measured while writing this.
 */

/** A real derived profile — the threshold reads its window, nothing else. */
const profile = boundProfile("minimax-m3");

/** ~500 tokens of ordinary French prose. A repeated character tokenises far
 *  below its length and would make every size assertion here a fiction. */
const bulk = (marker: string): string =>
  `${marker} ` +
  "Le rapprochement du lot a été vérifié ligne à ligne et les écarts reportés au registre. ".repeat(
    30,
  );

const transcript = (count: number): UIMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i.toString()}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: bulk(`tour-${i.toString()}`) }],
  })) as UIMessage[];

/** `compact`, with a summariser that records what it was handed. */
const loadCompact = async () => {
  const seen: UIMessage[][] = [];
  await mockModule("../../src/services/compaction/summarizer", {
    summariseMessages: (messages: UIMessage[]) => {
      seen.push(messages);
      return Promise.resolve("<summary>Handover.</summary>");
    },
  });
  const mod = await import("../../../src/services/compaction/compact");
  return { ...mod, seen };
};

describe("compaction keeps a verbatim tail", () => {
  test("the summariser reads the head, and only the head", async () => {
    const { compactConversation, seen } = await loadCompact();
    const messages = transcript(20);
    let kept = 0;

    await compactConversation(messages, {
      profile,
      // The tail budget is a quarter of this — about the last four messages.
      maxThresholdTokens: 8_000,
      onCompacted: (artifact) => {
        kept = artifact.keptTailCount;
      },
    });

    expect(kept).toBeGreaterThan(0);
    const head = seen.at(-1);
    expect(head).toHaveLength(messages.length - kept);
    // The tail's ids must not appear in what the summariser was given — that is
    // the whole difference between "kept whole" and "kept whole AND described".
    const headIds = new Set(head?.map((m) => m.id));
    for (const m of messages.slice(-kept)) {
      expect(headIds.has(m.id)).toBe(false);
    }
  });

  test("the tail comes back last, in order, byte for byte", async () => {
    const { compactConversation } = await loadCompact();
    const messages = transcript(20);
    let kept = 0;

    const out = await compactConversation(messages, {
      profile,
      maxThresholdTokens: 8_000,
      onCompacted: (artifact) => {
        kept = artifact.keptTailCount;
      },
    });

    expect(kept).toBeGreaterThan(0);
    // The summary (and the activation replay, where there is one) leads; the
    // tail is the suffix, unchanged and still in order.
    expect(out.slice(-kept)).toEqual(messages.slice(-kept));
    expect(out[0]?.role).toBe("user");
    expect(JSON.stringify(out[0])).toContain("Handover.");
  });

  test("`keptTailCount` describes the output the checkpoint will cut around", async () => {
    // The count a checkpoint subtracts from its window's length. If it
    // described anything else, the cut would cross the tail and the next window
    // would carry it twice — once folded into the summary, once as its rows.
    const { compactConversation } = await loadCompact();
    const messages = transcript(20);
    let kept = -1;

    const out = await compactConversation(messages, {
      profile,
      maxThresholdTokens: 8_000,
      onCompacted: (artifact) => {
        kept = artifact.keptTailCount;
      },
    });

    expect(kept).toBeGreaterThan(0);
    // No tool was ever activated in this transcript, so there is no activation
    // replay: the output is the summary plus exactly the tail it reports.
    expect(out).toHaveLength(1 + kept);
    expect(out.slice(1)).toEqual(messages.slice(-kept));
  });

  test("the tail shrinks with the cap instead of growing with the history", async () => {
    // The clause that stops a compaction from handing the next turn a window
    // already near the cap, which would compact again, forever. Same
    // transcript, a cap four times smaller: fewer messages survive.
    const { compactConversation } = await loadCompact();
    const messages = transcript(20);
    let wide = 0;
    let narrow = 0;

    await compactConversation(messages, {
      profile,
      maxThresholdTokens: 8_000,
      onCompacted: (a) => {
        wide = a.keptTailCount;
      },
    });
    await compactConversation(messages, {
      profile,
      maxThresholdTokens: 2_000,
      onCompacted: (a) => {
        narrow = a.keptTailCount;
      },
    });

    expect(narrow).toBeLessThan(wide);
  });

  test("what comes back still opens the next turn well under the cap", async () => {
    // The property the fraction exists to produce, asserted on the output
    // rather than on the constant.
    const { compactConversation } = await loadCompact();
    const { estimateMessagesTokens } =
      await import("../../../src/services/compaction/token-estimator");
    const out = await compactConversation(transcript(20), {
      profile,
      maxThresholdTokens: 8_000,
    });
    expect(estimateMessagesTokens(out, profile)).toBeLessThan(8_000 / 2);
  });
});
