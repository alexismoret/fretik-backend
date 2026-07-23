import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { withReasoningReplayStrip } from "../../../src/agents/shared/agent-builder";
import { getProfile } from "../../../src/lib/model-registry/resolve";

/**
 * `reasoning.replayInHistory: false` (MiniMax M3) strips the model's own past
 * reasoning parts from every step's messages — replayed reasoning triggers
 * the documented understanding-execution gap (announces the tool call, emits
 * EOS instead — prod zombies 2026-07-22/23; controlled replay: replayed 4/5
 * tool calls vs stripped 5/5). Profiles without the flag pass through
 * untouched.
 */

const MESSAGES: ModelMessage[] = [
  { role: "user", content: "analyse the file" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "let me think about which tool fits…" },
      { type: "text", text: "Reading the file." },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "read",
        input: { file_path: "a.pdf" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read",
        output: { type: "text", value: "content" },
      },
    ],
  },
  // Reasoning-only assistant message (never carries tool calls) — dropped
  // whole rather than left empty.
  {
    role: "assistant",
    content: [{ type: "reasoning", text: "pondering…" }],
  },
];

const callWith = async (profileKey: string) => {
  const prepared = withReasoningReplayStrip(
    async () => ({}),
    getProfile(profileKey),
  );
  // Only `messages` matters to the wrapper; the rest of the SDK options
  // object is irrelevant to this pure transform.
  return (await prepared({
    messages: MESSAGES,
    stepNumber: 0,
    steps: [],
    model: undefined,
  } as never)) as { messages?: ModelMessage[] };
};

describe("withReasoningReplayStrip", () => {
  test("minimax-m3 (replayInHistory: false) → reasoning parts stripped, text/tool calls kept", async () => {
    const result = await callWith("minimax-m3");
    const messages = result.messages ?? [];
    // Reasoning-only assistant message dropped entirely.
    expect(messages).toHaveLength(3);
    const assistant = messages[1];
    if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected array-content assistant message");
    }
    expect(assistant.content.map((p) => p.type)).toEqual(["text", "tool-call"]);
  });

  test("profile without the flag → messages untouched (no override returned)", async () => {
    const result = await callWith("deepseek-v4-pro");
    expect(result.messages).toBeUndefined();
  });
});
