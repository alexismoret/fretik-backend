import { describe, expect, test } from "bun:test";
import type { ToolApprovalOpResult } from "../../src/db/schema";
import {
  opWroteNothing,
  planFailureSummary,
} from "../../src/services/external-apps/exec/plan-outcome";

/**
 * The predicate that decides whether an executed plan is cached.
 *
 * `consumed` is a replay cache keyed by `lookupHash`, and the hash omits
 * volatile payloads on purpose — so caching a plan that wrote nothing hands
 * the OLD failure back to an agent that has already fixed what it sent. That
 * is the production incident of 2026-09-16: an upload rejected for one empty
 * payload, corrected, re-sent, answered with the identical error, and four
 * minutes spent working around a healthy server.
 *
 * Pure logic, hence unit — the status transition it drives lives in
 * `tests/integration/approvals/plan-all-failed.test.ts`, because that one is
 * two `where` clauses.
 */

const rows = (...values: boolean[]): ToolApprovalOpResult => ({
  ok: true,
  data: { value: values.map((ok) => ({ ok, path: "out/f.csv" })) },
});

describe("opWroteNothing", () => {
  test("a failed op wrote nothing", () => {
    expect(opWroteNothing({ ok: false, error: "boom" })).toBe(true);
  });

  test("an op whose every row failed also wrote nothing", () => {
    // THE shape that makes the two 2026-09-16 fixes compose: once a bad
    // payload became a per-file row instead of a throw, a wholly-failed
    // upload started arriving as an `ok:true` op. A discriminator reading
    // only the outer `ok` would cache it and rebuild the trap.
    expect(opWroteNothing(rows(false, false))).toBe(true);
  });

  test("one succeeding row means something was written", () => {
    // The double-write guard: re-issuing a half-succeeded plan is exactly
    // how a partner receives a file twice.
    expect(opWroteNothing(rows(false, true))).toBe(false);
  });

  test("an unrecognised data shape counts as a write", () => {
    expect(opWroteNothing({ ok: true, data: { value: [] } })).toBe(false);
    expect(opWroteNothing({ ok: true, data: { id: "msg-1" } })).toBe(false);
    expect(opWroteNothing({ ok: true, data: { value: "sent" } })).toBe(false);
  });

  test("a row list of non-records is not read as failure", () => {
    expect(opWroteNothing({ ok: true, data: { value: [1, 2] } })).toBe(false);
  });
});

describe("planFailureSummary", () => {
  test("names every distinct reason", () => {
    const summary = planFailureSummary([
      { ok: false, error: "connection refused" },
      rows(false),
    ]);
    expect(summary).toContain("connection refused");
  });

  test("carries a failed row's own reason, not just the op's", () => {
    const summary = planFailureSummary([
      {
        ok: true,
        data: {
          value: [
            { ok: false, path: "a", error: "not valid base64" },
            { ok: false, path: "b", error: "permission denied" },
          ],
        },
      },
    ]);
    expect(summary).toContain("not valid base64");
    expect(summary).toContain("permission denied");
  });

  test("does not repeat one reason shared by twenty rows", () => {
    const value = Array.from({ length: 20 }, (_, i) => ({
      ok: false,
      path: `f${i.toString()}`,
      error: "permission denied",
    }));
    const summary = planFailureSummary([{ ok: true, data: { value } }]);
    expect(summary).toBe("permission denied");
  });

  test("stays inside the card's budget for a large all-failed batch", () => {
    const value = Array.from({ length: 20 }, (_, i) => ({
      ok: false,
      path: `f${i.toString()}`,
      error: `row ${i.toString()} failed: ${"detail ".repeat(20)}`,
    }));
    expect(
      planFailureSummary([{ ok: true, data: { value } }]).length,
    ).toBeLessThanOrEqual(1000);
  });

  test("says so when the outcome is genuinely unknown", () => {
    // A transfer that ran out of wall clock may have been accepted first.
    // Without this the agent retries blind and the partner gets it twice.
    const summary = planFailureSummary(
      [{ ok: false, error: "The file server did not finish within 50s." }],
      new Set([0]),
    );
    expect(summary).toContain("UNKNOWN");
  });

  test("stays quiet about uncertainty that was not reported", () => {
    const summary = planFailureSummary([{ ok: false, error: "boom" }]);
    expect(summary).not.toContain("UNKNOWN");
  });
});
