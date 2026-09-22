/**
 * Where the turn-volatile block lands, and what it must not disturb.
 *
 * The whole saving depends on one property: the bytes BEFORE the block are
 * byte-identical to what the previous turn sent. Every assertion here is a
 * different way of breaking that — mutating the caller's array (so the history
 * that gets persisted carries last turn's recall), changing the message count
 * (so `selectBreakpointIndices` re-anchors), or appending to a tool result (so
 * the model reads the block as output of its own call).
 */
import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { appendTurnContext } from "../../../src/agents/shared/turn-context";

const BLOCK = "<turn_context>\nThe current date is Tuesday.\n</turn_context>";

describe("appendTurnContext", () => {
  test("appends a part to the last user message, leaving the count alone", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    const out = appendTurnContext(messages, BLOCK);

    // The count is the load-bearing half: `selectBreakpointIndices` picks
    // anchors by index and role, so one extra message moves every breakpoint.
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "second" },
        { type: "text", text: BLOCK },
      ],
    });
  });

  test("a part array is extended, not replaced", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", data: "aGk=", mediaType: "application/pdf" },
        ],
      },
    ];
    const out = appendTurnContext(messages, BLOCK);
    const content = out[0]?.content;
    if (content === undefined || typeof content === "string") {
      throw new Error("expected parts");
    }
    expect(content).toHaveLength(3);
    // The native file part must still be there — stripping it would send the
    // PDF back through the tool path it was deliberately kept out of.
    expect(content[1]).toMatchObject({ type: "file" });
    expect(content[2]).toEqual({ type: "text", text: BLOCK });
  });

  test("pushes its own message when the last one is not the user's", () => {
    // A continuation resumed at a turn boundary ends on a tool message. A
    // block appended there reads as the output of a call the model made.
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ];
    const out = appendTurnContext(messages, BLOCK);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", content: BLOCK });
  });

  test("an empty block changes nothing", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    expect(appendTurnContext(messages, "   \n  ")).toEqual(messages);
  });

  test("never mutates the caller's array or its messages", () => {
    // The caller hands us the array it is about to persist. Mutating it is how
    // turn 3's recall ends up installed in the history for turns 4 through 30.
    const original: ModelMessage[] = [{ role: "user", content: "hello" }];
    const snapshot = structuredClone(original);
    const out = appendTurnContext(original, BLOCK);

    expect(original).toEqual(snapshot);
    expect(out).not.toBe(original);
    expect(out[0]).not.toBe(original[0]);
  });

  test("an empty history gets the block as a user message", () => {
    expect(appendTurnContext([], BLOCK)).toEqual([
      { role: "user", content: BLOCK },
    ]);
  });
});
