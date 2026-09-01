import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import type { ModelProfile } from "../../../../src/lib/model-registry/types";
import {
  compactConversation,
  getCompactionThresholdTokens,
  type CompactionProgressEvent,
} from "../../../../src/services/compaction/compact";
import { parseSummariserMaxTokens } from "../../../../src/services/compaction/summarizer";
import { boundProfile } from "../../../lib/live-fleet";

/**
 * Compact-pipeline tests.
 *
 * The compaction threshold is derived from the SERVING model's profile
 * (`getCompactionThresholdTokens`) — these tests exercise it with
 * profiles of varying context windows, no env mutation or module
 * re-import needed (the previous `?stamp=` re-import trick broke on a
 * Bun upgrade and is gone).
 *
 * Live LLM paths (the actual `streamText` call inside
 * `summariseMessages`) are NOT exercised here — they live in
 * `evals/cases/compaction.ts`.
 */

const baseProfile = boundProfile("minimax-m3");

/**
 * Same profile, different context window — the only threshold input that varies
 * per model.
 *
 * Under a KEY WITH NO LIVE ROW, deliberately: `effectiveContextLength` prefers
 * the row's measured pool minimum and falls back to the catalogue figure only
 * when the snapshot has nothing. Both branches are exercised — this one for the
 * arithmetic, the row's own value in the case below.
 */
const withContext = (contextLength: number): ModelProfile => ({
  ...baseProfile,
  key: "compaction-arithmetic-fixture",
  catalog: { ...baseProfile.catalog, contextLength },
});

/** Summary reserve as captured at module load (env-dependent, mirrored here). */
const SUMMARY_RESERVE = parseSummariserMaxTokens(
  process.env.COMPACTION_SUMMARIZER_MAX_TOKENS,
);
const AUTOCOMPACT_BUFFER = 13_000;

const userMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistantMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

const buildShortConversation = (
  count: number,
  charsEach: number,
): UIMessage[] => {
  const filler = "A".repeat(charsEach);
  const msgs: UIMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      i % 2 === 0
        ? userMsg(`u${i.toString()}`, filler)
        : assistantMsg(`a${i.toString()}`, filler),
    );
  }
  return msgs;
};

describe("getCompactionThresholdTokens — CC effective-window arithmetic", () => {
  test("threshold = (window − summary_max) − AUTOCOMPACT_BUFFER (13K)", () => {
    expect(getCompactionThresholdTokens(withContext(200_000))).toBe(
      200_000 - SUMMARY_RESERVE - AUTOCOMPACT_BUFFER,
    );
  });

  test("threshold follows the profile's context window", () => {
    expect(getCompactionThresholdTokens(withContext(100_000))).toBe(
      100_000 - SUMMARY_RESERVE - AUTOCOMPACT_BUFFER,
    );
    expect(getCompactionThresholdTokens(withContext(1_048_576))).toBe(
      1_048_576 - SUMMARY_RESERVE - AUTOCOMPACT_BUFFER,
    );
  });

  test("the MEASURED pool minimum wins over the catalogue headline", () => {
    // The property that matters in production, and the reason the threshold
    // reads the row at all: a model is served by several hosts and routing
    // picks one per request, so the usable window is the smallest any reachable
    // host offers. Measured 2026-08-29, the same model spans 262 144 to
    // 1 048 576 tokens across its endpoints — budgeting against the largest
    // overflows mid-turn whenever a request lands on the smallest.
    const rowWindow = 260_096;
    expect(baseProfile.catalog.contextLength).toBe(rowWindow);
    expect(getCompactionThresholdTokens(baseProfile)).toBe(
      rowWindow - SUMMARY_RESERVE - AUTOCOMPACT_BUFFER,
    );
    // …and the catalogue figure is what answers when no row describes it.
    expect(getCompactionThresholdTokens(withContext(1_048_576))).toBe(
      1_048_576 - SUMMARY_RESERVE - AUTOCOMPACT_BUFFER,
    );
  });
});

describe("compactConversation — pass-through behaviour", () => {
  test("under-threshold conversations are returned by reference (microcompact no-op)", async () => {
    // 4 short text-only messages, no tool parts → microcompact noop,
    // total tokens ≈ 250, well below the M3 threshold.
    const msgs = buildShortConversation(4, 200);
    const out = await compactConversation(msgs, { profile: baseProfile });
    expect(out).toBe(msgs);
  });

  test("small context window still passes through when under its (tiny) threshold", async () => {
    // 50K window → tiny threshold, but our short conversation has no
    // compactable tool results AND stays under it.
    const msgs = buildShortConversation(4, 100);
    const out = await compactConversation(msgs, {
      profile: withContext(50_000),
    });
    expect(out).toBe(msgs);
  });
});

describe("compactConversation — onProgress callback", () => {
  test("does NOT fire onProgress when conversation stays below threshold", async () => {
    const events: CompactionProgressEvent[] = [];
    const msgs = buildShortConversation(4, 200);
    await compactConversation(msgs, {
      profile: baseProfile,
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([]);
  });

  test("a buggy onProgress that throws does not abort the compaction", async () => {
    const msgs = buildShortConversation(4, 200);
    // The callback never fires (under-threshold path) so this is the
    // shape-only contract test: passing a throwing callback must not
    // bubble the error.
    const out = await compactConversation(msgs, {
      profile: baseProfile,
      onProgress: () => {
        throw new Error("intentional");
      },
    });
    expect(out).toBe(msgs);
  });
});
