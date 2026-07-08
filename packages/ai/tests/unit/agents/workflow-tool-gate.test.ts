import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_FORBIDDEN_DOMAIN_TOOLS,
  workflowMainHiddenToolNames,
  workflowSubAgentHiddenToolNames,
} from "../../../src/agents/shared/workflow-tool-gate";

/**
 * The write gate is the ONLY thing keeping a non-autonomous run from writing
 * team data directly (`manageRecord`/`manageLink`) or touching schema
 * (`manageObjectType`/…). It is applied identically to the main workflow agent
 * and to workflow-dispatched sub-agents, so a regression here silently reopens
 * the delegation-bypass hole. These pin each mode's hidden set.
 */

describe("workflowMainHiddenToolNames", () => {
  test("read_only hides direct writes AND memory", () => {
    const hidden = workflowMainHiddenToolNames("read_only");
    expect(hidden.has("manageRecord")).toBe(true);
    expect(hidden.has("manageLink")).toBe(true);
    expect(hidden.has("memory")).toBe(true);
  });

  test("approval_required hides direct writes but KEEPS memory", () => {
    const hidden = workflowMainHiddenToolNames("approval_required");
    expect(hidden.has("manageRecord")).toBe(true);
    expect(hidden.has("manageLink")).toBe(true);
    expect(hidden.has("memory")).toBe(false);
  });

  test("autonomous hides nothing", () => {
    const hidden = workflowMainHiddenToolNames("autonomous");
    expect(hidden.size).toBe(0);
  });

  test("never hides schema/meta tools (the main registry already omits them)", () => {
    for (const mode of [
      "read_only",
      "approval_required",
      "autonomous",
    ] as const) {
      const hidden = workflowMainHiddenToolNames(mode);
      for (const name of WORKFLOW_FORBIDDEN_DOMAIN_TOOLS) {
        expect(hidden.has(name)).toBe(false);
      }
    }
  });
});

describe("workflowSubAgentHiddenToolNames", () => {
  test("hides the schema/meta tools in EVERY mode (shares the chat registry)", () => {
    for (const mode of [
      "read_only",
      "approval_required",
      "autonomous",
    ] as const) {
      const hidden = workflowSubAgentHiddenToolNames(mode);
      for (const name of WORKFLOW_FORBIDDEN_DOMAIN_TOOLS) {
        expect(hidden.has(name)).toBe(true);
      }
    }
  });

  test("autonomous still exposes direct writes (only schema/meta hidden)", () => {
    const hidden = workflowSubAgentHiddenToolNames("autonomous");
    expect(hidden.has("manageRecord")).toBe(false);
    expect(hidden.has("manageLink")).toBe(false);
  });

  test("approval_required hides writes + schema/meta, keeps memory", () => {
    const hidden = workflowSubAgentHiddenToolNames("approval_required");
    expect(hidden.has("manageRecord")).toBe(true);
    expect(hidden.has("manageObjectType")).toBe(true);
    expect(hidden.has("memory")).toBe(false);
  });

  test("read_only is the strictest — writes, memory, and schema/meta all hidden", () => {
    const hidden = workflowSubAgentHiddenToolNames("read_only");
    expect(hidden.has("manageRecord")).toBe(true);
    expect(hidden.has("manageLink")).toBe(true);
    expect(hidden.has("memory")).toBe(true);
    expect(hidden.has("manageField")).toBe(true);
  });
});
