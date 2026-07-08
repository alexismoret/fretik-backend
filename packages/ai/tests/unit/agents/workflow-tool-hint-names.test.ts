import { describe, expect, test } from "bun:test";
import { workflowToolHintNames } from "../../../src/agents/workflow/tools";

/**
 * `manageWorkflow` validates a playbook's `toolHints` against this set so a
 * typo or a forbidden tool bounces at author time instead of silently no-op'ing
 * at run time. The set is the workflow registry's core + domain tools, with the
 * schema/meta/builder tools excluded (`WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`).
 */
describe("workflowToolHintNames", () => {
  const names = workflowToolHintNames();

  test("includes the workflow-only core tools", () => {
    expect(names.has("completeTask")).toBe(true);
    expect(names.has("askUserQuestion")).toBe(true);
    expect(names.has("dispatchAgent")).toBe(true);
  });

  test("includes gated-but-valid domain write tools (name is real; runtime gate withholds them)", () => {
    expect(names.has("manageRecord")).toBe(true);
    expect(names.has("manageLink")).toBe(true);
  });

  test("excludes the forbidden schema / meta / builder tools", () => {
    for (const forbidden of [
      "manageObjectType",
      "manageField",
      "createSkill",
      "updateSkill",
      "manageWorkflow",
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  test("is memoized (same set instance across calls)", () => {
    expect(workflowToolHintNames()).toBe(names);
  });
});
