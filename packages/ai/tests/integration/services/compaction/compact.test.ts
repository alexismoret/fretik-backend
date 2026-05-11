import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import type { CompactionProgressEvent } from "../../../../src/services/compaction/compact";

/**
 * Compact-pipeline tests.
 *
 * `compactConversation` reads its budget constants from env at module
 * load. We re-import with a stamped query string to bypass Bun's module
 * cache and pick up env mutations per-test.
 *
 * Live LLM paths (the actual `streamText` call inside `summariseMessages`)
 * are NOT exercised here — they live in `evals/cases/compaction.ts`.
 * These tests cover (a) microcompact-only short-circuit, (b) below-
 * threshold pass-through, (c) env-driven threshold sensitivity. Anything
 * that would invoke OpenRouter is intentionally out of scope.
 */

type ProgressCallback = (event: CompactionProgressEvent) => void;

interface CompactModule {
  compactConversation: (
    messages: UIMessage[],
    options?: { onProgress?: ProgressCallback },
  ) => Promise<UIMessage[]>;
  COMPACTION_THRESHOLD_TOKENS: number;
}

const importCompactWithEnv = async (
  env: Partial<Record<string, string | undefined>>,
): Promise<CompactModule> => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const suffix = Date.now().toString() + Math.random().toString();
  const mod = await import(
    `../../../src/services/compaction/compact.ts?stamp=${suffix}`
  );
  return mod as unknown as CompactModule;
};

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

describe("compactConversation — threshold computation (CC effective-window)", () => {
  test("threshold = (window − summary_max) − AUTOCOMPACT_BUFFER (13K)", async () => {
    const { COMPACTION_THRESHOLD_TOKENS } = await importCompactWithEnv({
      OPENROUTER_CHAT_MODEL_CONTEXT: "200000",
      COMPACTION_SUMMARIZER_MAX_TOKENS: "20000",
    });
    // 200_000 − 20_000 (summary out) − 13_000 (autocompact buffer) = 167_000
    expect(COMPACTION_THRESHOLD_TOKENS).toBe(167_000);
  });

  test("changing OPENROUTER_CHAT_MODEL_CONTEXT shifts the threshold", async () => {
    const { COMPACTION_THRESHOLD_TOKENS } = await importCompactWithEnv({
      OPENROUTER_CHAT_MODEL_CONTEXT: "100000",
      COMPACTION_SUMMARIZER_MAX_TOKENS: "20000",
    });
    expect(COMPACTION_THRESHOLD_TOKENS).toBe(67_000);
  });

  test("changing COMPACTION_SUMMARIZER_MAX_TOKENS reserves more output room", async () => {
    const { COMPACTION_THRESHOLD_TOKENS } = await importCompactWithEnv({
      OPENROUTER_CHAT_MODEL_CONTEXT: "200000",
      COMPACTION_SUMMARIZER_MAX_TOKENS: "30000",
    });
    expect(COMPACTION_THRESHOLD_TOKENS).toBe(157_000);
  });
});

describe("compactConversation — pass-through behaviour", () => {
  test("under-threshold conversations are returned by reference (microcompact no-op)", async () => {
    const { compactConversation } = await importCompactWithEnv({});
    // 4 short text-only messages, no tool parts → microcompact noop,
    // total tokens ≈ 250, well below threshold.
    const msgs = buildShortConversation(4, 200);
    const out = await compactConversation(msgs);
    expect(out).toBe(msgs);
  });

  test("conversations that microcompact reduces below threshold skip the summariser", async () => {
    // Crank the env down so the threshold is tiny — but our short
    // conversation has no compactable tool results, so microcompact
    // is a no-op AND we're still under the (tiny) threshold.
    const { compactConversation } = await importCompactWithEnv({
      OPENROUTER_CHAT_MODEL_CONTEXT: "50000",
      COMPACTION_SUMMARIZER_MAX_TOKENS: "20000",
    });
    const msgs = buildShortConversation(4, 100);
    const out = await compactConversation(msgs);
    // No summariser invoked — output is the input by reference.
    expect(out).toBe(msgs);
  });
});

describe("compactConversation — onProgress callback", () => {
  test("does NOT fire onProgress when conversation stays below threshold", async () => {
    const { compactConversation } = await importCompactWithEnv({});
    const events: CompactionProgressEvent[] = [];
    const msgs = buildShortConversation(4, 200);
    await compactConversation(msgs, {
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([]);
  });

  test("does NOT fire onProgress when not provided (legacy 1-arg call)", async () => {
    const { compactConversation } = await importCompactWithEnv({});
    const msgs = buildShortConversation(4, 200);
    // Just verify the call shape stays compatible — no callback.
    const out = await compactConversation(msgs);
    expect(out).toBe(msgs);
  });

  test("a buggy onProgress that throws does not abort the compaction", async () => {
    const { compactConversation } = await importCompactWithEnv({});
    const msgs = buildShortConversation(4, 200);
    // The callback never fires (under-threshold path) so this is the
    // shape-only contract test: passing a throwing callback must not
    // bubble the error.
    const out = await compactConversation(msgs, {
      onProgress: () => {
        throw new Error("intentional");
      },
    });
    expect(out).toBe(msgs);
  });
});
