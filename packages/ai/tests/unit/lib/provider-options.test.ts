/**
 * The merge that lets an agent add one provider option without destroying its
 * neighbours.
 *
 * The bug this replaces was invisible: `prepareCall` REPLACES the call settings
 * wholesale, so spreading `providerOptions` to add `session_id` would have
 * erased whatever the caller had put under `openrouter` — the handler's
 * `file-parser` plugin on a native-PDF turn, or the delegate's reasoning level.
 * No error, no warning; just a turn that quietly ran at the wrong depth or
 * re-OCR'd a PDF it was told to keep raw.
 */
import { describe, expect, test } from "bun:test";
import { mergeProviderOptions } from "../../../src/lib/provider-options";

describe("mergeProviderOptions", () => {
  test("adds a key without dropping the caller's other keys", () => {
    // The exact shape in play: the chatbot handler sends `plugins` for a native
    // PDF, and the agent adds `session_id` underneath it.
    const merged = mergeProviderOptions(
      { openrouter: { plugins: [{ id: "file-parser" }] } },
      { openrouter: { session_id: "conv-1" } },
    );
    expect(merged["openrouter"]).toEqual({
      plugins: [{ id: "file-parser" }],
      session_id: "conv-1",
    });
  });

  test("the patch wins on a key both sides set", () => {
    const merged = mergeProviderOptions(
      { openrouter: { session_id: "old" } },
      { openrouter: { session_id: "new" } },
    );
    expect(merged["openrouter"]).toEqual({ session_id: "new" });
  });

  test("other namespaces are left untouched", () => {
    const merged = mergeProviderOptions(
      { gateway: { only: ["groq"] }, openrouter: { plugins: [] } },
      { openrouter: { session_id: "conv-1" } },
    );
    expect(merged["gateway"]).toEqual({ only: ["groq"] });
  });

  test("an absent base is the patch", () => {
    expect(
      mergeProviderOptions(undefined, { openrouter: { session_id: "c" } }),
    ).toEqual({ openrouter: { session_id: "c" } });
  });

  test("a value is REPLACED whole, never blended with the one underneath", () => {
    // The test that will catch a future "helpful" recursive merge. `reasoning`
    // is a discriminated union — `{enabled, max_tokens}` or `{enabled, effort}`
    // — and an object carrying both is a body OpenRouter rejects.
    const merged = mergeProviderOptions(
      { openrouter: { reasoning: { enabled: true, max_tokens: 8000 } } },
      { openrouter: { reasoning: { enabled: true, effort: "high" } } },
    );
    expect(merged["openrouter"]?.["reasoning"]).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  test("neither input is mutated", () => {
    const base = { openrouter: { plugins: [] } };
    const patch = { openrouter: { session_id: "c" } };
    mergeProviderOptions(base, patch);
    expect(base).toEqual({ openrouter: { plugins: [] } });
    expect(patch).toEqual({ openrouter: { session_id: "c" } });
  });
});
