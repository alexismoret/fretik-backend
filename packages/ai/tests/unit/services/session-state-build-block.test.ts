import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { TaskManager } from "../../../src/agents/shared/task-manager";
import { buildSessionStateBlock } from "../../../src/services/session-state/build-block";

/**
 * Pure unit tests for the heartbeat `<session_state>` block. The
 * service has no I/O — it just reads two in-process snapshots and
 * formats them as markdown — so these cases are fully deterministic
 * and don't need any harness.
 *
 * The block ends up at the very bottom of the system prompt's
 * dynamic suffix; the prompt renderer substitutes a friendly
 * placeholder ("_No active session state._") when this function
 * returns the empty string. Both branches are covered below.
 */

const makeManagers = () => ({
  dynamicToolManager: new DynamicToolManager(),
  taskManager: new TaskManager(),
});

describe("buildSessionStateBlock", () => {
  test("returns empty string when no tools activated and no tasks pending", () => {
    const inputs = makeManagers();
    expect(buildSessionStateBlock(inputs)).toBe("");
  });

  test("renders activated tools when any are present", () => {
    const inputs = makeManagers();
    inputs.dynamicToolManager.activate(["listDocuments", "getEntityDetails"]);
    const block = buildSessionStateBlock(inputs);
    expect(block).toContain("Activated domain tools");
    expect(block).toContain("listDocuments");
    expect(block).toContain("getEntityDetails");
    // Order of names mirrors `getSnapshot()` insertion order.
    expect(block.indexOf("listDocuments")).toBeLessThan(
      block.indexOf("getEntityDetails"),
    );
  });

  test("renders pending tasks (skips completed)", () => {
    const inputs = makeManagers();
    inputs.taskManager.setTasks([
      {
        content: "Compile top 5 carriers",
        activeForm: "Compiling top 5 carriers",
        status: "in_progress",
      },
      {
        content: "Generate Excel summary",
        activeForm: "Generating Excel summary",
        status: "pending",
      },
      {
        content: "Old finished thing",
        activeForm: "Doing old finished thing",
        status: "completed",
      },
    ]);
    const block = buildSessionStateBlock(inputs);
    expect(block).toContain("Pending tasks");
    expect(block).toContain("Compile top 5 carriers");
    expect(block).toContain("(in_progress)");
    expect(block).toContain("Generate Excel summary");
    expect(block).toContain("(pending)");
    // Completed task must NOT leak into the heartbeat — it's noise
    // that pushes the model toward re-doing already-done work.
    expect(block).not.toContain("Old finished thing");
  });

  test("renders BOTH tools and tasks when both are populated", () => {
    const inputs = makeManagers();
    inputs.dynamicToolManager.activate(["listDocuments"]);
    inputs.taskManager.setTasks([
      {
        content: "Step A",
        activeForm: "Doing step A",
        status: "in_progress",
      },
    ]);
    const block = buildSessionStateBlock(inputs);
    expect(block).toContain("Activated domain tools");
    expect(block).toContain("Pending tasks");
    // Tools listed before tasks so the parent agent sees what's
    // unlocked before what's outstanding.
    expect(block.indexOf("Activated domain tools")).toBeLessThan(
      block.indexOf("Pending tasks"),
    );
  });

  test("returns empty string when ALL tasks are completed", () => {
    const inputs = makeManagers();
    inputs.taskManager.setTasks([
      {
        content: "Step A",
        activeForm: "Doing step A",
        status: "completed",
      },
    ]);
    expect(buildSessionStateBlock(inputs)).toBe("");
  });
});
