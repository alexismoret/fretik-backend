/**
 * Unit tests for the eval harness's mechanical tool-call validation
 * (`evals/tool-schemas.ts`). The schema map is built from the SAME
 * factories production registers, so these tests double as a
 * registry-drift guard: if a core tool is renamed, the names test
 * breaks here before a gate run silently stops validating it.
 */

import { describe, expect, test } from "bun:test";
import { validateToolCalls } from "../../../evals/tool-schemas";

describe("validateToolCalls", () => {
  test("valid dispatchAgent input counts as valid", () => {
    const summary = validateToolCalls([
      {
        name: "dispatchAgent",
        input: {
          task: "Summarise the attached quarterly report end-to-end.",
          description: "Summarise report",
        },
        output: undefined,
      },
    ]);
    expect(summary.total).toBe(1);
    expect(summary.valid).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  test("malformed input is counted invalid with a failure detail", () => {
    const summary = validateToolCalls([
      {
        name: "dispatchAgent",
        // `task` must be a string of ≥10 chars; `description` missing.
        input: { task: 42 },
        output: undefined,
      },
    ]);
    expect(summary.total).toBe(1);
    expect(summary.valid).toBe(0);
    expect(summary.failures.length).toBe(1);
    expect(summary.failures[0]).toContain("dispatchAgent");
  });

  test("unknown tool names are harness gaps, not model failures", () => {
    const summary = validateToolCalls([
      { name: "unknown", input: {}, output: undefined },
    ]);
    expect(summary.total).toBe(0);
    expect(summary.valid).toBe(0);
    expect(summary.unknown).toBe(1);
    expect(summary.failures).toEqual([]);
  });

  test("core + domain registry names resolve to schemas", () => {
    const names = [
      "searchKnowledge",
      "querySql",
      "searchWeb",
      "read",
      "vision",
      "python",
      "bash",
      "presentFiles",
      "searchTools",
      "memory",
      "askUserQuestion",
      "listDocuments",
      "webFetch",
      "dispatchAgent",
    ];
    const summary = validateToolCalls(
      names.map((name) => ({ name, input: undefined, output: undefined })),
    );
    expect(summary.unknown).toBe(0);
    expect(summary.total).toBe(names.length);
  });
});
