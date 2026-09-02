import { describe, expect, test } from "bun:test";
import {
  parseSummariserMaxTokens,
  parseSummariserTimeoutMs,
  summariseMessages,
} from "../../../../src/services/compaction/summarizer";

/**
 * The summariser's max_tokens and timeout are parsed from the
 * environment ONCE at module load (its MODEL comes from the registry's
 * `compaction-summarizer` role — code, not env). The parsing logic is
 * exported as pure functions so each clamp case is testable directly —
 * the previous query-string re-import trick (`?stamp=`) broke on a Bun
 * upgrade and is gone.
 *
 * Note: actual `streamText` calls are NOT exercised here — that path
 * touches OpenRouter and lives in `evals/cases/compaction.ts`. These
 * tests cover configuration parsing + the soft-fail contract on empty
 * input.
 */

describe("summarizer — configuration parsing", () => {
  test("max tokens defaults to 20000 (unset / unparseable)", () => {
    expect(parseSummariserMaxTokens(undefined)).toBe(20_000);
    expect(parseSummariserMaxTokens("")).toBe(20_000);
    expect(parseSummariserMaxTokens("not-a-number")).toBe(20_000);
  });

  test("max tokens override is honoured", () => {
    expect(parseSummariserMaxTokens("12000")).toBe(12_000);
  });

  test("max tokens clamps at the upper bound (32k)", () => {
    expect(parseSummariserMaxTokens("999999")).toBe(32_000);
  });

  test("max tokens clamps at the lower bound (2k)", () => {
    expect(parseSummariserMaxTokens("50")).toBe(2_000);
  });

  test("timeout defaults to 90s and clamps to [10s, 300s]", () => {
    expect(parseSummariserTimeoutMs(undefined)).toBe(90_000);
    expect(parseSummariserTimeoutMs("60000")).toBe(60_000);
    expect(parseSummariserTimeoutMs("1")).toBe(10_000);
    expect(parseSummariserTimeoutMs("9999999")).toBe(300_000);
  });
});

describe("summarizer — empty input contract", () => {
  test("empty message list returns null without hitting the provider", async () => {
    const result = await summariseMessages([], undefined);
    expect(result).toBeNull();
  });
});
