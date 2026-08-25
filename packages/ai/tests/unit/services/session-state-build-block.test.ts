import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { buildSessionStateBlock } from "../../../src/services/session-state/build-block";

/**
 * Pure unit tests for the heartbeat `<session_state>` block. The
 * service has no I/O — it just reads an in-process snapshot and
 * formats it as markdown — so these cases are fully deterministic
 * and don't need any harness.
 *
 * The block ends up at the very bottom of the system prompt's
 * dynamic suffix; the prompt renderer substitutes a friendly
 * placeholder ("_No active session state._") when this function
 * returns the empty string. Both branches are covered below.
 */

const makeInputs = () => ({
  dynamicToolManager: new DynamicToolManager(),
});

describe("buildSessionStateBlock", () => {
  test("returns empty string when no tools activated", () => {
    const inputs = makeInputs();
    expect(buildSessionStateBlock(inputs)).toBe("");
  });

  test("renders activated tools when any are present", () => {
    const inputs = makeInputs();
    inputs.dynamicToolManager.activate(["listDocuments", "getRecord"]);
    const block = buildSessionStateBlock(inputs);
    expect(block).toContain("Activated domain tools");
    expect(block).toContain("listDocuments");
    expect(block).toContain("getRecord");
    // Order of names mirrors `getSnapshot()` insertion order.
    expect(block.indexOf("listDocuments")).toBeLessThan(
      block.indexOf("getRecord"),
    );
  });
});
