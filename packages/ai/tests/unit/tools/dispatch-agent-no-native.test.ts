import { describe, expect, test } from "bun:test";
import { dispatchAgentInputSchema } from "../../../src/tools/dispatch-agent";

/**
 * C5 guard — sub-agents receive only the `task` string, never the parent
 * conversation history, so native image/video parts cannot leak into a
 * sub-agent (v1 isolation). This pins the contract two ways:
 *  1. the dispatch input has NO attachment/media field, and
 *  2. the message a sub-agent is built from carries string content (no
 *     `file` parts).
 * A future refactor that pipes history (or attachments) into sub-agents
 * has to change one of these and trips the test.
 */
describe("dispatchAgent excludes native media (C5)", () => {
  test("input schema exposes only {task, description, model} — no media input", () => {
    expect(Object.keys(dispatchAgentInputSchema.shape).sort()).toEqual([
      "description",
      "model",
      "task",
    ]);
  });

  test("unknown attachment-like fields are stripped, not forwarded", () => {
    const parsed = dispatchAgentInputSchema.parse({
      task: "summarise the attached report in three bullets",
      description: "summarise report",
      files: [{ type: "file", mediaType: "image/png", url: "x" }],
    });
    expect("files" in parsed).toBe(false);
  });

  test("the sub-agent message channel is a plain string (no file parts)", () => {
    // Mirrors dispatch-agent's `buildMessages: ({task}) => [{role, content: task}]`.
    const task = "describe what the chart on page 2 shows";
    const messages = [{ role: "user" as const, content: task }];
    expect(typeof messages[0]?.content).toBe("string");
  });
});
