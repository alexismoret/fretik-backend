import { describe, expect, test } from "bun:test";
import { buildDelegateBrief } from "../../../src/agents/chatbot/delegate-brief";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
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
  test("input schema carries a brief and two switches — no media input", () => {
    // `model` and `background` are enums/booleans: neither can carry a file.
    expect(Object.keys(dispatchAgentInputSchema.shape).sort()).toEqual([
      "background",
      "description",
      "model",
      "skills",
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

  test("the sub-agent message channel is a plain string (no file parts)", async () => {
    // The brief `buildMessages` sends is one string built from the parent's
    // rendered context and the task — never the parent's message parts.
    const brief = await buildDelegateBrief(
      { task: "describe what the chart on page 2 shows" },
      wrapRuntimeContext({
        organizationId: "org-1",
        teamId: "team-1",
        modelProfile: getProfileForRole("chat"),
        dynamicToolManager: new DynamicToolManager(),
      }),
    );
    expect(typeof brief).toBe("string");
    expect(brief).toContain("<task>");
  });
});
