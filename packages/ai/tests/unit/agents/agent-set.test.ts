import type { StepResult, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import {
  stopOnRepeatedToolErrors,
  trailingToolErrorRun,
} from "../../../src/agents/shared/agent-set";

/** Minimal step fixtures — only `toolResults` matters to the shape-matched
 * conditions under test (same fixture idiom as `chatbot-tool.test.ts`). */
const steps = (
  perStep: { toolName: string; output: unknown }[][],
): StepResult<ToolSet>[] =>
  perStep.map((toolResults) => ({
    toolResults,
  })) as unknown as StepResult<ToolSet>[];

const fail = (toolName: string, code: string) => ({
  toolName,
  output: { error: "boom", code },
});
const ok = (toolName: string) => ({ toolName, output: { ok: true } });

describe("trailingToolErrorRun", () => {
  test("null on no steps / no failures", () => {
    expect(trailingToolErrorRun([])).toBeNull();
    expect(trailingToolErrorRun(steps([[ok("extract")]]))).toBeNull();
  });

  test("counts a trailing identical-failure run across steps", () => {
    const run = trailingToolErrorRun(
      steps([
        [fail("extract", "INVALID_SCHEMA")],
        [fail("extract", "INVALID_SCHEMA")],
        [fail("extract", "INVALID_SCHEMA")],
      ]),
    );
    expect(run).toEqual({
      count: 3,
      toolName: "extract",
      code: "INVALID_SCHEMA",
    });
  });

  test("counts parallel same-step failures", () => {
    const run = trailingToolErrorRun(
      steps([
        [fail("extract", "INVALID_SCHEMA"), fail("extract", "INVALID_SCHEMA")],
      ]),
    );
    expect(run?.count).toBe(2);
  });

  test("a success resets the run", () => {
    const run = trailingToolErrorRun(
      steps([
        [fail("extract", "INVALID_SCHEMA")],
        [ok("extract")],
        [fail("extract", "INVALID_SCHEMA")],
      ]),
    );
    expect(run?.count).toBe(1);
  });

  test("a different tool or code restarts the run", () => {
    expect(
      trailingToolErrorRun(
        steps([
          [fail("extract", "INVALID_SCHEMA")],
          [fail("python", "PYTHON_ERROR")],
        ]),
      ),
    ).toEqual({ count: 1, toolName: "python", code: "PYTHON_ERROR" });
    expect(
      trailingToolErrorRun(
        steps([
          [fail("extract", "INVALID_SCHEMA")],
          [fail("extract", "EXTRACT_ERROR")],
        ]),
      )?.count,
    ).toBe(1);
  });
});

describe("stopOnRepeatedToolErrors", () => {
  test("fires only at the configured limit", async () => {
    const stop = stopOnRepeatedToolErrors<ToolSet>(3);
    const two = steps([
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
    ]);
    const three = steps([
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
    ]);
    expect(await stop({ steps: two })).toBe(false);
    expect(await stop({ steps: three })).toBe(true);
  });
});

// A background launch (`backgroundRun: true`) deliberately has NO stop
// condition: the agent may keep working in the same turn, and the wait
// registry resumes the conversation once every launched task is settled.
