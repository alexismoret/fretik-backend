import type {
  LanguageModelV3Message,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import {
  applyCacheControl,
  selectBreakpointIndices,
  shouldInjectCacheControl,
} from "../../../src/lib/openrouter-cache";

/**
 * Pure-function unit tests for the OpenRouter prompt-caching middleware.
 * No model calls, no env mutation — these only cover the placement
 * algorithm and the immutability contract that the rest of the chatbot
 * stack relies on (preserving `reasoning_details` and the original
 * prompt shape across turns).
 */

const sys = (text = "system"): LanguageModelV3Message => ({
  role: "system",
  content: text,
});

const user = (text = "u"): LanguageModelV3Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistant = (text = "a"): LanguageModelV3Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const toolMsg = (callId = "c1"): LanguageModelV3Message => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: callId,
      toolName: "noop",
      output: { type: "text", value: "ok" },
    },
  ],
});

describe("shouldInjectCacheControl", () => {
  test("matches Anthropic, Qwen, and deepseek-v3.2 (case-insensitive)", () => {
    expect(shouldInjectCacheControl("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(shouldInjectCacheControl("qwen/qwen3.6-plus")).toBe(true);
    expect(shouldInjectCacheControl("Qwen/Qwen3-Max")).toBe(true);
    expect(shouldInjectCacheControl("deepseek/deepseek-v3.2")).toBe(true);
  });

  test("rejects auto-caching upstreams and unrelated models", () => {
    expect(shouldInjectCacheControl("deepseek/deepseek-v4-pro")).toBe(false);
    expect(shouldInjectCacheControl("deepseek/deepseek-r1")).toBe(false);
    expect(shouldInjectCacheControl("openai/gpt-5")).toBe(false);
    expect(shouldInjectCacheControl("openai/gpt-oss-120b")).toBe(false);
    expect(shouldInjectCacheControl("google/gemini-2.5-pro")).toBe(false);
    expect(shouldInjectCacheControl("x-ai/grok-4")).toBe(false);
    expect(shouldInjectCacheControl("minimax/mimo-v2.5-pro")).toBe(false);
    expect(shouldInjectCacheControl("minimax/minimax-m2")).toBe(false);
  });
});

describe("selectBreakpointIndices", () => {
  test("empty prompt returns no breakpoints", () => {
    expect(selectBreakpointIndices([])).toEqual([]);
  });

  test("system-only prompt caches just the system message", () => {
    expect(selectBreakpointIndices([sys()])).toEqual([0]);
  });

  test("system + single user emits two breakpoints (system + last)", () => {
    expect(selectBreakpointIndices([sys(), user()])).toEqual([0, 1]);
  });

  test("no system message: last index only when no stable mid-anchor exists", () => {
    expect(selectBreakpointIndices([user(), user()])).toEqual([1]);
  });

  test("short prompt under MID_ANCHOR threshold skips the mid anchor", () => {
    const prompt: LanguageModelV3Prompt = [
      sys(),
      user(),
      assistant(),
      toolMsg(),
      assistant("final"),
    ];
    const indices = selectBreakpointIndices(prompt);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(prompt.length - 1);
    expect(indices.length).toBeLessThanOrEqual(3);
  });

  test("long prompt yields up to four monotonically increasing breakpoints", () => {
    const prompt: LanguageModelV3Prompt = [
      sys(),
      user("turn1 question"),
      assistant("plan"),
      toolMsg("c1"),
      toolMsg("c2"),
      assistant("more plan"),
      toolMsg("c3"),
      assistant("turn1 final"),
      user("turn2 question"),
      assistant("turn2 plan"),
      toolMsg("c4"),
      assistant("turn2 final"),
      user("turn3 question — current"),
    ];
    const indices = selectBreakpointIndices(prompt);
    expect(indices.length).toBeGreaterThanOrEqual(3);
    expect(indices.length).toBeLessThanOrEqual(4);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(prompt.length - 1);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  test("mid anchor lands in the first quarter of the post-system range", () => {
    // n=20 → quarterEnd = 0 + floor(19/4) = 4. midAnchor must be ≤ 4.
    const prompt: LanguageModelV3Prompt = [sys()];
    for (let i = 0; i < 19; i++) {
      prompt.push(i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`));
    }
    const indices = selectBreakpointIndices(prompt);
    expect(indices.length).toBe(4);
    const [systemIdx, midAnchor, recentAnchor, lastIdx] = indices;
    expect(systemIdx).toBe(0);
    expect(midAnchor).toBeGreaterThan(0);
    expect(midAnchor!).toBeLessThanOrEqual(4);
    expect(recentAnchor!).toBeGreaterThan(midAnchor!);
    expect(recentAnchor!).toBeLessThan(lastIdx!);
    expect(lastIdx).toBe(prompt.length - 1);
  });

  test("mid anchor moves slower than the prompt grows (sliding stability)", () => {
    const base: LanguageModelV3Prompt = [sys()];
    for (let i = 0; i < 19; i++) {
      base.push(i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`));
    }
    const before = selectBreakpointIndices(base);

    // Add one tool-loop step worth of messages.
    const grown: LanguageModelV3Prompt = [
      ...base,
      assistant("another"),
      toolMsg("c-grow"),
      user("turn-something"),
    ];
    const after = selectBreakpointIndices(grown);

    expect(after[0]).toBe(before[0]!);
    if (before.length === 4 && after.length === 4) {
      const midDelta = after[1]! - before[1]!;
      const lastDelta = after[3]! - before[3]!;
      // The whole point of the "first 25 %" rule.
      expect(midDelta).toBeLessThan(lastDelta);
      expect(midDelta).toBeLessThanOrEqual(2);
    }
  });

  test("recent anchor immediately precedes a final user message", () => {
    const prompt: LanguageModelV3Prompt = [
      sys(),
      user("q1"),
      assistant("a1"),
      toolMsg(),
      assistant("a2"),
      user("q2"),
      assistant("a3"),
      toolMsg(),
      assistant("a4"),
      toolMsg(),
      assistant("a5"),
      user("q3 — fresh"),
    ];
    const indices = selectBreakpointIndices(prompt);
    const recentAnchor = indices.at(-2)!;
    const recentMsg = prompt[recentAnchor]!;
    expect(recentMsg.role === "assistant" || recentMsg.role === "tool").toBe(
      true,
    );
    expect(recentAnchor).toBe(prompt.length - 2);
  });

  test("returns at most 4 breakpoints regardless of prompt length", () => {
    const prompt: LanguageModelV3Prompt = [sys()];
    for (let i = 0; i < 50; i++) {
      prompt.push(i % 3 === 0 ? user(`u${i}`) : assistant(`a${i}`));
    }
    expect(selectBreakpointIndices(prompt).length).toBeLessThanOrEqual(4);
  });
});

describe("applyCacheControl", () => {
  test("system breakpoint attaches at MESSAGE level (content is string)", () => {
    const prompt: LanguageModelV3Prompt = [sys(), user(), assistant()];
    const result = applyCacheControl(prompt, [0]);
    // System content is `string` per V3 type; cache_control therefore
    // lives on the message itself — the SDK preserves this code path.
    expect(result[0]!.providerOptions?.openrouter?.cacheControl).toEqual({
      type: "ephemeral",
    });
    expect(result[1]!.providerOptions).toBeUndefined();
  });

  test("non-system breakpoint attaches on the LAST content-part", () => {
    const prompt: LanguageModelV3Prompt = [
      sys(),
      user(),
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second-and-last" },
        ],
      },
    ];
    const result = applyCacheControl(prompt, [2]);
    const assistantMsg = result[2];
    if (assistantMsg?.role !== "assistant") throw new Error("unexpected role");
    // Message-level providerOptions stay untouched.
    expect(assistantMsg.providerOptions).toBeUndefined();
    // First content-part gets nothing.
    expect(assistantMsg.content[0]?.providerOptions).toBeUndefined();
    // Last content-part carries the cache_control marker — this is what
    // the OpenRouter provider forwards to Alibaba/Qwen and Anthropic
    // upstreams without dropping it during content normalisation.
    expect(
      assistantMsg.content[1]?.providerOptions?.openrouter?.cacheControl,
    ).toEqual({ type: "ephemeral" });
  });

  test("tool message: cache_control lands on the tool_result part", () => {
    const prompt: LanguageModelV3Prompt = [sys(), toolMsg("c1")];
    const result = applyCacheControl(prompt, [1]);
    const tMsg = result[1];
    if (tMsg?.role !== "tool") throw new Error("unexpected role");
    expect(tMsg.providerOptions).toBeUndefined();
    expect(tMsg.content[0]?.providerOptions?.openrouter?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  test("merges with existing part-level providerOptions (preserves siblings)", () => {
    const reasoningSig = { signature: "abc", redacted: false };
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: { reasoningDetails: [reasoningSig] },
            },
          },
          {
            type: "text",
            text: "answer",
            providerOptions: { custom: { keep: 1 } },
          },
        ],
      },
    ];
    const result = applyCacheControl(prompt, [0]);
    const msg = result[0];
    if (msg?.role !== "assistant") throw new Error("unexpected role");
    // Reasoning part untouched.
    expect(
      msg.content[0]?.providerOptions?.openrouter?.reasoningDetails,
    ).toEqual([reasoningSig]);
    expect(
      msg.content[0]?.providerOptions?.openrouter?.cacheControl,
    ).toBeUndefined();
    // Text part keeps its sibling namespace AND gets cache_control.
    expect(msg.content[1]?.providerOptions?.custom).toEqual({ keep: 1 });
    expect(msg.content[1]?.providerOptions?.openrouter?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  test("does not mutate the input prompt", () => {
    const prompt: LanguageModelV3Prompt = [
      sys(),
      user(),
      { ...assistant(), providerOptions: { openrouter: { foo: 1 } } },
    ];
    const snapshot = structuredClone(prompt);
    applyCacheControl(prompt, [0, 1, 2]);
    expect(prompt).toEqual(snapshot);
  });

  test("empty indices returns the same prompt reference", () => {
    const prompt: LanguageModelV3Prompt = [sys(), user()];
    expect(applyCacheControl(prompt, [])).toBe(prompt);
  });
});
