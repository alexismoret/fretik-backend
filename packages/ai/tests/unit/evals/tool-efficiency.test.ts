/**
 * Unit tests for the eval harness's tool-calling EFFICIENCY summary
 * (`evals/tool-efficiency.ts`). Pure + deterministic — no live service.
 * Covers per-tool counts, canonical {error,code} detection, error→retry
 * (dispatch-ordered), key-order-insensitive redundancy, and the opt-in
 * per-case budget (overage + off-allowlist).
 */

import { describe, expect, test } from "bun:test";
import { summarizeToolEfficiency } from "../../../evals/tool-efficiency";
import type { ToolCallTrace } from "../../../evals/types";

const call = (
  name: string,
  input: unknown,
  output: unknown = "ok",
  startedAtMs?: number,
): ToolCallTrace => ({
  name,
  input,
  output,
  ...(startedAtMs !== undefined ? { startedAtMs } : {}),
});

const toolError = { error: "boom", code: "INTERNAL_ERROR" };

describe("summarizeToolEfficiency", () => {
  test("empty turn → all zero, no budget", () => {
    const s = summarizeToolEfficiency([]);
    expect(s.totalCalls).toBe(0);
    expect(s.perTool).toEqual({});
    expect(s.errorCalls).toBe(0);
    expect(s.errorThenRetry).toBe(0);
    expect(s.redundantCalls).toBe(0);
    expect(s.budget).toBeUndefined();
  });

  test("per-tool counts and total", () => {
    const s = summarizeToolEfficiency([
      call("python", { code: "a" }),
      call("python", { code: "b" }),
      call("querySql", { sql_query: "select 1" }),
    ]);
    expect(s.totalCalls).toBe(3);
    expect(s.perTool).toEqual({ python: 2, querySql: 1 });
  });

  test("only canonical {error,code} outputs count as errored", () => {
    const s = summarizeToolEfficiency([
      call("querySql", { sql_query: "x" }, toolError),
      call("read", { file_path: "a" }, "file contents"),
      call("python", { code: "y" }, { error: "no code field" }), // no `code`
    ]);
    expect(s.errorCalls).toBe(1);
  });

  test("error→retry counts an errored call with a later same-tool call (dispatch order)", () => {
    // Array is out of dispatch order; sorting by startedAtMs puts the
    // errored python (t=100) before the successful retry (t=200).
    const s = summarizeToolEfficiency([
      call("python", { code: "retry" }, "ok", 200),
      call("python", { code: "boom" }, toolError, 100),
    ]);
    expect(s.errorCalls).toBe(1);
    expect(s.errorThenRetry).toBe(1);
  });

  test("error with no later same-tool call is not a retry", () => {
    const s = summarizeToolEfficiency([
      call("bash", { command: "x" }, toolError, 100),
      call("python", { code: "y" }, "ok", 200),
    ]);
    expect(s.errorCalls).toBe(1);
    expect(s.errorThenRetry).toBe(0);
  });

  test("redundancy is key-order-insensitive; surplus is count − 1 per group", () => {
    const s = summarizeToolEfficiency([
      call("querySql", { a: 1, b: 2 }),
      call("querySql", { b: 2, a: 1 }), // same call, keys reordered
      call("querySql", { b: 2, a: 1 }), // third identical → surplus 2 total
      call("read", { file_path: "a" }), // distinct → no surplus
    ]);
    expect(s.redundantCalls).toBe(2);
  });

  test("budget overage = calls beyond maxToolCalls; off-allowlist counted separately", () => {
    const s = summarizeToolEfficiency(
      [
        call("python", { code: "x" }),
        call("bash", { command: "y" }),
        call("querySql", { sql_query: "z" }),
      ],
      { maxToolCalls: 1, expectedTools: ["python"] },
    );
    expect(s.budget).toBeDefined();
    expect(s.budget?.maxToolCalls).toBe(1);
    expect(s.budget?.overage).toBe(2); // 3 calls − max 1
    expect(s.budget?.offAllowlist).toBe(2); // bash + querySql off the allowlist
  });

  test("budget with only maxToolCalls → off-allowlist 0; within budget → overage 0", () => {
    const s = summarizeToolEfficiency([call("python", { code: "x" })], {
      maxToolCalls: 3,
    });
    expect(s.budget?.overage).toBe(0);
    expect(s.budget?.offAllowlist).toBe(0);
  });

  test("budget with only expectedTools → overage 0 (no ceiling)", () => {
    const s = summarizeToolEfficiency(
      [call("python", { code: "x" }), call("read", { file_path: "a" })],
      { expectedTools: ["python", "read"] },
    );
    expect(s.budget?.maxToolCalls).toBeUndefined();
    expect(s.budget?.overage).toBe(0);
    expect(s.budget?.offAllowlist).toBe(0);
  });
});
