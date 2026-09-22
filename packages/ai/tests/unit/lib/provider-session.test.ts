/**
 * The sticky key's derivation, and the one case where sending nothing is the
 * right answer.
 *
 * The defect these guard against is silent in both directions. Key a
 * conversation on the per-turn trace id and every turn opens a new lane — the
 * exact behaviour `session_id` exists to replace, with no error to notice. Key
 * a delegate on the parent's conversation and the two share one pin, so a
 * provider error inside a sub-agent re-pins the PARENT onto a host its prefix
 * is cold on.
 */
import { describe, expect, test } from "bun:test";
import {
  providerSessionId,
  SESSION_ID_MAX_CHARS,
} from "../../../src/lib/provider-session";

describe("providerSessionId", () => {
  test("a conversation is keyed on the conversation, never on the turn", () => {
    const key = providerSessionId("conversation", {
      conversationId: "conv-1",
      traceId: "stream-abc",
    });
    expect(key).toBe("conv-1");
    // The property that matters is stability ACROSS turns: the same
    // conversation with a different turn id must produce the same key.
    expect(
      providerSessionId("conversation", {
        conversationId: "conv-1",
        traceId: "stream-def",
      }),
    ).toBe(key);
  });

  test("two conversations never share a lane", () => {
    expect(providerSessionId("conversation", { conversationId: "a" })).not.toBe(
      providerSessionId("conversation", { conversationId: "b" }),
    );
  });

  test("a workflow run wins over the conversation it belongs to", () => {
    // The run is the span with a continuous prefix; the conversation around it
    // can outlive several runs.
    expect(
      providerSessionId("conversation", {
        conversationId: "conv-1",
        workflowRunId: "run-9",
      }),
    ).toBe("run-9");
  });

  test("a delegate gets its OWN lane, not the parent's conversation", () => {
    // This is the assertion that would catch someone "simplifying" the scope
    // away. `dispatchAgent` forwards the parent's conversationId and resolves
    // the same model, so falling back to it here would put both on one pin.
    const key = providerSessionId("delegate", {
      conversationId: "conv-1",
      traceId: "stream-abc.sub",
    });
    expect(key).toBe("stream-abc.sub");
    expect(key).not.toBe("conv-1");
  });

  test("a delegate with no trace id sends nothing rather than the parent's key", () => {
    // Sending nothing lets OpenRouter hash the opening messages, which for a
    // delegate is a good key — its first non-system message is the whole
    // briefing and never changes. Reaching for the conversation would recreate
    // the shared-pin problem.
    expect(
      providerSessionId("delegate", { conversationId: "conv-1" }),
    ).toBeUndefined();
  });

  test("an absent or empty id sends nothing", () => {
    expect(providerSessionId("conversation", {})).toBeUndefined();
    expect(
      providerSessionId("conversation", { conversationId: "" }),
    ).toBeUndefined();
  });

  test("a key longer than OpenRouter accepts is clamped, not dropped", () => {
    const key = providerSessionId("conversation", {
      conversationId: "x".repeat(SESSION_ID_MAX_CHARS + 50),
    });
    expect(key).toHaveLength(SESSION_ID_MAX_CHARS);
  });
});
