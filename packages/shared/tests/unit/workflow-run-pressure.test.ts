import { describe, expect, test } from "bun:test";
import type { WorkflowActiveRun } from "../../src/schemas/workflows";
import { liveTriggerCompletenessError } from "../../src/schemas/workflows";
import {
  emptyRunPressure,
  summarizeRunPressure,
} from "../../src/services/workflows/run-pressure";

/**
 * Run pressure is what makes "this workflow is blocked" a readable fact
 * rather than three unrelated approval rows. It was written after a live
 * workflow sat silent for six days behind unanswered approvals while every
 * surface — the hub, the dashboard, the assistant — reported it as active.
 */

const run = (over: Partial<WorkflowActiveRun>): WorkflowActiveRun => ({
  runId: "01a0a43e-f1fb-74e6-95a8-b1d5ee39966b",
  workflowId: "wf-1",
  status: "queued",
  isTest: false,
  startedAt: null,
  pausedAt: null,
  createdAt: "2026-09-15T08:00:00.000Z",
  ...over,
});

describe("summarizeRunPressure", () => {
  test("counts each non-terminal status per workflow", () => {
    const pressure = summarizeRunPressure([
      run({ workflowId: "wf-1", status: "needs_approval" }),
      run({ workflowId: "wf-1", status: "needs_approval" }),
      run({ workflowId: "wf-1", status: "queued" }),
      run({ workflowId: "wf-2", status: "running" }),
    ]);

    expect(pressure.get("wf-1")).toMatchObject({
      needsApproval: 2,
      queued: 1,
      running: 0,
    });
    expect(pressure.get("wf-2")).toMatchObject({
      running: 1,
      needsApproval: 0,
      queued: 0,
    });
    // A workflow with no active run is absent, not zeroed — the caller
    // substitutes `emptyRunPressure()`.
    expect(pressure.get("wf-3")).toBeUndefined();
    expect(emptyRunPressure().needsApproval).toBe(0);
  });

  test("waitingSince is the OLDEST unanswered approval, not the newest", () => {
    const pressure = summarizeRunPressure([
      run({ status: "needs_approval", pausedAt: "2026-09-18T05:46:48.000Z" }),
      run({ status: "needs_approval", pausedAt: "2026-09-15T08:46:33.000Z" }),
      run({ status: "needs_approval", pausedAt: "2026-09-17T06:52:55.000Z" }),
    ]);

    // The age of the oldest question is how long the workflow has been
    // stuck; reporting the newest would understate it by days.
    expect(pressure.get("wf-1")?.waitingSince).toBe("2026-09-15T08:46:33.000Z");
  });

  test("compares instants, not strings, across Date and ISO rows", () => {
    // `isoDate` is `string | Date` on the wire, so the two shapes coexist in
    // one response. A lexicographic compare would order them by chance.
    const pressure = summarizeRunPressure([
      run({ status: "needs_approval", pausedAt: "2026-09-18T05:46:48.000Z" }),
      run({
        status: "needs_approval",
        pausedAt: new Date("2026-09-15T08:46:33.000Z"),
      }),
    ]);

    expect(
      new Date(pressure.get("wf-1")?.waitingSince ?? 0).toISOString(),
    ).toBe("2026-09-15T08:46:33.000Z");
  });

  test("falls back to createdAt when a parked run carries no pausedAt", () => {
    const pressure = summarizeRunPressure([
      run({
        status: "needs_approval",
        pausedAt: null,
        createdAt: "2026-09-11T08:56:49.000Z",
      }),
    ]);

    expect(pressure.get("wf-1")?.waitingSince).toBe("2026-09-11T08:56:49.000Z");
  });

  test("a parked TEST run still counts — it holds the slot too", () => {
    const pressure = summarizeRunPressure([
      run({ status: "needs_approval", isTest: true }),
    ]);

    expect(pressure.get("wf-1")?.needsApproval).toBe(1);
  });
});

describe("liveTriggerCompletenessError", () => {
  test("refuses an event trigger left with no subscription", () => {
    // The 2026-09-21 defect: `triggerConfig: {}` on a live event workflow.
    // It stayed "active", matched nothing, and never ran again.
    const error = liveTriggerCompletenessError("event", {});

    expect(error).not.toBeNull();
    expect(error).toContain("subscribed to nothing");
  });

  test("accepts an event trigger that still lists an event", () => {
    expect(
      liveTriggerCompletenessError("event", {
        event: { events: [{ type: "document.uploaded" }] },
      }),
    ).toBeNull();
  });

  test("refuses a cron trigger left without a pattern", () => {
    expect(liveTriggerCompletenessError("cron", {})).toContain("cron pattern");
  });

  test("refuses a form trigger left without a definition", () => {
    expect(liveTriggerCompletenessError("form", {})).toContain(
      "form definition",
    );
  });

  test("manual needs nothing — it is fired by hand", () => {
    expect(liveTriggerCompletenessError("manual", {})).toBeNull();
  });
});
