import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import { describe, expect, test } from "bun:test";
import { buildSubAgentContinuation } from "../../../src/services/conversation-tasks/sub-agent-continuation";

/**
 * What the resumed agent reads about a finished sub-agent. The report has no
 * other home — the tool call that launched it returned before the work began
 * — so the line must carry it whole, a run that died without one must say so
 * rather than come back empty, and one the user stopped must say who did.
 */

const task = (
  subAgent: NonNullable<ConversationBackgroundTask["metadata"]>["subAgent"],
  status: ConversationBackgroundTask["status"] = "succeeded",
): ConversationBackgroundTask => ({
  id: "task-1",
  conversationId: "conv-1",
  kind: "sub_agent",
  ref: "agent-1",
  title: "Payment terms watch",
  status,
  metadata: { subAgent },
  completedAt: new Date(),
  consumedAt: null,
  createdAt: new Date(),
});

describe("sub-agent continuation", () => {
  test("a finished run carries its whole report, its files and its launcher", () => {
    const built = buildSubAgentContinuation(
      task({
        launchedByUserId: "user-7",
        result: {
          status: "partial",
          reason: "step_budget",
          summary: "Found 3 of 5 practices.\n- Net 60 is the ceiling.",
          files: ["outputs/watch.md"],
          toolCalls: 40,
          durationMs: 5 * 60_000,
          activity: [],
        },
      }),
    );
    expect(built.actingUserId).toBe("user-7");
    expect(built.line).toBe(
      'Sub-agent "Payment terms watch" (agent-1) partial (step_budget) — 40 tool calls, 5 min.\n<report>\nFound 3 of 5 practices.\n- Net 60 is the ceiling.\n</report>\nFiles: outputs/watch.md',
    );
  });

  test("a run that died with no report says it wrote none", () => {
    const built = buildSubAgentContinuation(task({ step: 4 }));
    expect(built.line).toBe(
      'Sub-agent "Payment terms watch" (agent-1) failed: it stopped before finishing and wrote no report.',
    );
    expect(built.actingUserId).toBeNull();
  });

  test("a run the user stopped says so, and keeps what it had written", () => {
    const built = buildSubAgentContinuation(
      task(
        {
          stopRequested: "user",
          result: {
            status: "failed",
            reason: "stopped",
            summary: "The sub-agent was stopped after 6 tool calls.",
            files: ["outputs/draft.md"],
            toolCalls: 6,
            durationMs: 60_000,
            activity: [],
          },
        },
        "canceled",
      ),
    );
    expect(built.line).toBe(
      'Sub-agent "Payment terms watch" (agent-1) was stopped by the user after 6 tool calls; it wrote no report.\nFiles: outputs/draft.md',
    );
  });
});
