import { describe, expect, test } from "bun:test";
import {
  detectManualReruns,
  judgeRunEvidence,
  MANUAL_RERUN_WINDOW_MS,
  type RunEvidenceFacts,
} from "../../src/services/trajectory/ground-truth";

/**
 * The gate between "the harness says succeeded" and "this run may teach".
 *
 * Written against the measured failure it exists to prevent: an audit of a
 * memory system that promoted whatever its judge called a success found about
 * half of those promotions had come from runs that failed, because the judge
 * only saw the final state.
 */

const GREEN: RunEvidenceFacts = {
  runId: "r1",
  status: "succeeded",
  isTest: false,
  declaresDeliverable: true,
  outputCount: 1,
  rejectedApprovals: 0,
  manualRerunWithinWindow: false,
};

const at = (iso: string): Date => new Date(iso);

describe("judgeRunEvidence", () => {
  test("a clean run teaches", () => {
    expect(judgeRunEvidence(GREEN)).toEqual({ usable: true });
  });

  test("anything that is not succeeded is out", () => {
    for (const status of [
      "queued",
      "running",
      "needs_approval",
      "failed",
      "canceled",
    ] as const) {
      expect(judgeRunEvidence({ ...GREEN, status })).toEqual({
        usable: false,
        reason: "not-succeeded",
      });
    }
  });

  test("a builder test run is a rehearsal, not evidence", () => {
    expect(judgeRunEvidence({ ...GREEN, isTest: true })).toEqual({
      usable: false,
      reason: "test-run",
    });
  });

  test("a playbook that pins a deliverable is not honoured by an empty run", () => {
    // This is the clause `status = succeeded` cannot express: every task
    // closed, the agent graded its own work, and nothing was produced.
    expect(judgeRunEvidence({ ...GREEN, outputCount: 0 })).toEqual({
      usable: false,
      reason: "deliverable-missing",
    });
  });

  test("a playbook that pins nothing is not judged on outputs", () => {
    expect(
      judgeRunEvidence({
        ...GREEN,
        declaresDeliverable: false,
        outputCount: 0,
      }),
    ).toEqual({ usable: true });
  });

  test("a refused approval disqualifies the run that closed green anyway", () => {
    expect(judgeRunEvidence({ ...GREEN, rejectedApprovals: 1 })).toEqual({
      usable: false,
      reason: "approval-rejected",
    });
  });

  test("a run someone re-ran by hand is negative evidence", () => {
    // The only signal in the system that means "that was not what I wanted".
    expect(
      judgeRunEvidence({ ...GREEN, manualRerunWithinWindow: true }),
    ).toEqual({ usable: false, reason: "manual-rerun" });
  });
});

describe("detectManualReruns", () => {
  const finished = at("2026-09-16T10:00:00Z");

  test("a manual run inside the window condemns the run before it", () => {
    const reruns = detectManualReruns([
      {
        id: "r1",
        triggerType: "cron",
        finishedAt: finished,
        createdAt: at("2026-09-16T09:00:00Z"),
      },
      {
        id: "r2",
        triggerType: "manual",
        finishedAt: null,
        createdAt: at("2026-09-16T10:30:00Z"),
      },
    ]);
    expect([...reruns]).toEqual(["r1"]);
  });

  test("the schedule firing again is not a person disagreeing", () => {
    const reruns = detectManualReruns([
      {
        id: "r1",
        triggerType: "cron",
        finishedAt: finished,
        createdAt: at("2026-09-16T09:00:00Z"),
      },
      {
        id: "r2",
        triggerType: "cron",
        finishedAt: null,
        createdAt: at("2026-09-16T10:30:00Z"),
      },
    ]);
    expect(reruns.size).toBe(0);
  });

  test("a relaunch past the window is tomorrow's work, not a complaint", () => {
    const reruns = detectManualReruns([
      {
        id: "r1",
        triggerType: "cron",
        finishedAt: finished,
        createdAt: at("2026-09-16T09:00:00Z"),
      },
      {
        id: "r2",
        triggerType: "manual",
        finishedAt: null,
        createdAt: new Date(finished.getTime() + MANUAL_RERUN_WINDOW_MS + 1000),
      },
    ]);
    expect(reruns.size).toBe(0);
  });

  test("a manual run before the run finished is not a rerun of it", () => {
    // Two runs launched together: the earlier one did not provoke the later.
    const reruns = detectManualReruns([
      {
        id: "r1",
        triggerType: "manual",
        finishedAt: finished,
        createdAt: at("2026-09-16T09:00:00Z"),
      },
      {
        id: "r2",
        triggerType: "manual",
        finishedAt: null,
        createdAt: at("2026-09-16T09:05:00Z"),
      },
    ]);
    expect(reruns.size).toBe(0);
  });

  test("a run still open is not judged", () => {
    const reruns = detectManualReruns([
      {
        id: "r1",
        triggerType: "manual",
        finishedAt: null,
        createdAt: at("2026-09-16T09:00:00Z"),
      },
      {
        id: "r2",
        triggerType: "manual",
        finishedAt: null,
        createdAt: at("2026-09-16T09:30:00Z"),
      },
    ]);
    expect(reruns.size).toBe(0);
  });
});
