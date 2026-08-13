import { describe, expect, test } from "bun:test";
import type { ConversationBackgroundTask } from "../../src/db/schema";
import { serializeConversationTask } from "../../src/services/conversation-tasks/serialize";

/**
 * The wait registry's DTO is the ONE surface the chat reads about background
 * work, whatever kind it is. `progress` is deliberately kind-agnostic — rows,
 * steps, files — because the task list is already polled while anything is
 * pending: a kind that keeps these two numbers fresh gets a live progress bar
 * with no query, endpoint or component of its own. These assertions pin that
 * the projection stays generic, and that a kind which counts nothing shows
 * nothing rather than a bar stuck at zero.
 */

const task = (
  metadata: ConversationBackgroundTask["metadata"],
): ConversationBackgroundTask => ({
  id: "019ff000-0000-7000-8000-000000000001",
  conversationId: "019ff000-0000-7000-8000-000000000002",
  kind: "bulk_operation",
  ref: "019ff000-0000-7000-8000-000000000003",
  title: "Importing 200000 records into client",
  status: "pending",
  metadata,
  completedAt: null,
  consumedAt: null,
  createdAt: new Date("2026-08-13T10:00:00Z"),
});

describe("conversation task DTO — generic progress", () => {
  test("absent when the kind counts nothing", () => {
    expect(serializeConversationTask(task(null)).progress).toBeNull();
    expect(
      serializeConversationTask(task({ workflowId: "w", isTest: false }))
        .progress,
    ).toBeNull();
  });

  test("reported once a total is known", () => {
    const dto = serializeConversationTask(
      task({ progressDone: 42_000, progressTotal: 200_000 }),
    );
    expect(dto.progress).toEqual({ done: 42_000, total: 200_000 });
  });

  test("a total with no count yet reads as zero, not as missing", () => {
    // The bar must appear as soon as the work announces its size — a load that
    // has written nothing yet is at 0 %, not "unknown".
    expect(
      serializeConversationTask(task({ progressTotal: 200_000 })).progress,
    ).toEqual({ done: 0, total: 200_000 });
  });

  test("the kind's own display fields survive alongside it", () => {
    const dto = serializeConversationTask(
      task({
        importTypeKey: "client",
        importRows: 200_000,
        progressDone: 1,
        progressTotal: 200_000,
      }),
    );
    expect(dto.importTypeKey).toBe("client");
    expect(dto.importRows).toBe(200_000);
    expect(dto.progress).toEqual({ done: 1, total: 200_000 });
    // Workflow-only fields stay at their neutral values for another kind.
    expect(dto.workflowId).toBeNull();
    expect(dto.isTest).toBe(false);
  });
});
