import { describe, expect, test } from "bun:test";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { workflowWriteBackstop } from "../../../src/agents/shared/workflow-write-backstop";

/**
 * The server-side backstop for `manageRecord` / `manageLink`. The step-gate
 * only PRUNES these from the menu; the AI SDK still executes a call the model
 * guesses by name, so this is the airtight check. Zero-cost in chat
 * (`workflowAutonomy` undefined → null, the write proceeds).
 */

const ctx = (
  autonomy: AgentRuntimeContext["workflowAutonomy"],
): AgentRuntimeContext =>
  ({ workflowAutonomy: autonomy }) as unknown as AgentRuntimeContext;

describe("workflowWriteBackstop", () => {
  test("chat (undefined) → null: the write proceeds", () => {
    expect(workflowWriteBackstop(ctx(undefined))).toBeNull();
  });

  test("autonomous → null: direct writes allowed", () => {
    expect(workflowWriteBackstop(ctx("autonomous"))).toBeNull();
  });

  test("read_only → structured error mentioning READ_ONLY", () => {
    const out = workflowWriteBackstop(ctx("read_only"));
    expect(out).not.toBeNull();
    expect(out?.error).toContain("READ_ONLY");
  });

  test("approval_required → error routes to the Python objects SDK", () => {
    const out = workflowWriteBackstop(ctx("approval_required"));
    expect(out).not.toBeNull();
    expect(out?.error).toContain("APPROVAL_REQUIRED");
    expect(out?.error).toContain("bulk_create");
  });
});
