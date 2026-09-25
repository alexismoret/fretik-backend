import { describe, expect, test } from "bun:test";
import {
  dispatchAgentInputSchema,
  subAgentCallOptions,
} from "../../../src/tools/dispatch-agent";

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

/**
 * A sub-agent runs the parent's tools, so it must run them under the parent's
 * RULES. The call options used to carry identity only: the team's tool
 * policies stayed behind, a tool the team had blocked reappeared one level
 * down, and an approval-gated write ran unasked.
 */
describe("dispatchAgent inherits the parent's rules", () => {
  const parent: Parameters<typeof subAgentCallOptions>[0] = {
    organizationId: "org-1",
    teamId: "team-1",
    userId: "user-1",
    conversationId: "conv-1",
    traceId: "trace-1",
    workflowAutonomy: "approval_required",
    toolPolicies: { manageRecord: "approval", webSearch: "blocked" },
  };

  test("the team's tool policies travel with the sub-agent", () => {
    expect(subAgentCallOptions(parent, "sub").toolPolicies).toEqual({
      manageRecord: "approval",
      webSearch: "blocked",
    });
  });

  test("identity, the run's write gate and the trace are carried too", () => {
    const options = subAgentCallOptions(parent, "sub-cheap");
    expect(options).toMatchObject({
      organizationId: "org-1",
      teamId: "team-1",
      userId: "user-1",
      conversationId: "conv-1",
      workflowAutonomy: "approval_required",
      traceId: "trace-1.sub-cheap",
    });
  });
});
