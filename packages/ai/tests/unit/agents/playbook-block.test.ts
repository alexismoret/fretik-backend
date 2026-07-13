import type { Workflow, WorkflowRun } from "@fretik/shared/db/schema";
import type { WorkflowTaskState } from "@fretik/shared/schemas/workflows";
import { describe, expect, test } from "bun:test";
import {
  buildPlaybookBlock,
  buildSteeringMessage,
} from "../../../src/agents/workflow/playbook-block";

/**
 * The playbook/steering split (W1+W2): the system-prompt `{{playbookBlock}}`
 * is byte-stable per run — full task list + instructions, NO live status or
 * outcomes — and everything that mutates per turn (date, statuses, current-task
 * pin, turn-1 recall) rides in the steering message at the context tail.
 */

const TASKS: WorkflowTaskState[] = [
  {
    key: "scan",
    title: "Scan inbox",
    description: "",
    instructions: "Read every unread message and extract the sender.",
    expectedOutput: "A list of senders.",
    status: "completed",
    summary: "Found 12 senders.",
  },
  {
    key: "classify",
    title: "Classify senders",
    description: "",
    instructions: "Tag each sender as client or vendor.",
    expectedOutput: "Tagged list.",
    status: "in_progress",
  },
  {
    key: "report",
    title: "Write report",
    description: "",
    instructions: "Summarise the classification.",
    status: "pending",
  },
];

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    triggerType: "manual",
    isTest: false,
    triggerPayload: {},
    taskStates: TASKS,
    ...over,
  }) as unknown as WorkflowRun;

const workflow = (): Workflow =>
  ({
    name: "Inbox triage",
    autonomy: "approval_required",
    playbook: { goal: "Triage the shared inbox", tasks: [] },
  }) as unknown as Workflow;

describe("buildPlaybookBlock (static, per-run)", () => {
  test("lists every task with its instructions and expected output", () => {
    const block = buildPlaybookBlock(workflow(), run());
    expect(block).toContain("Triage the shared inbox");
    expect(block).toContain("`scan`");
    expect(block).toContain(
      "Read every unread message and extract the sender.",
    );
    expect(block).toContain("Expected output: A list of senders.");
  });

  test("carries NO live status markers or outcomes (those move to steering)", () => {
    const block = buildPlaybookBlock(workflow(), run());
    expect(block).not.toContain("[x]");
    expect(block).not.toContain("[>]");
    expect(block).not.toContain("Outcome:");
    expect(block).not.toContain("Found 12 senders.");
  });

  test("is identical whatever the live statuses are (byte-stable per run)", () => {
    const a = buildPlaybookBlock(workflow(), run());
    const flipped = TASKS.map((t) => ({ ...t, status: "completed" as const }));
    const b = buildPlaybookBlock(workflow(), run({ taskStates: flipped }));
    expect(a).toBe(b);
  });
});

describe("buildSteeringMessage (per-turn, at the tail)", () => {
  test("carries the current date, status table and outcomes", () => {
    const msg = buildSteeringMessage({
      run: run(),
      turnIndex: 2,
      currentDate: "Tuesday, July 7, 2026, 15:45 (UTC, GMT+0)",
      nudge: false,
      wrapUp: false,
    });
    expect(msg).toContain("Current date: Tuesday, July 7, 2026");
    expect(msg).toContain("Task status:");
    expect(msg).toContain("[x] `scan`");
    expect(msg).toContain("[>] `classify`");
    expect(msg).toContain("[ ] `report`");
    expect(msg).toContain("`scan`: Found 12 senders.");
  });

  test("pins the current task by key + title + expected output ONLY (no full instructions)", () => {
    const msg = buildSteeringMessage({
      run: run(),
      turnIndex: 2,
      currentDate: "d",
      nudge: false,
      wrapUp: false,
    });
    expect(msg).toContain("Current task: `classify` — **Classify senders**");
    expect(msg).toContain("Expected output: Tagged list.");
    // The full instructions live once in the system playbook, never here.
    expect(msg).not.toContain("Tag each sender as client or vendor.");
  });

  test("turn 1 includes recall; later turns don't", () => {
    const first = buildSteeringMessage({
      run: run(),
      turnIndex: 1,
      currentDate: "d",
      activeMemoryBlock: "FACT: the ops mailbox is ops@acme.test",
      nudge: false,
      wrapUp: false,
    });
    expect(first).toContain("<active_memory>");
    expect(first).toContain("ops@acme.test");

    const later = buildSteeringMessage({
      run: run(),
      turnIndex: 2,
      currentDate: "d",
      nudge: false,
      wrapUp: false,
    });
    expect(later).not.toContain("<active_memory>");
  });

  test("announces the trigger on turn 1, continues on later turns", () => {
    const first = buildSteeringMessage({
      run: run(),
      turnIndex: 1,
      currentDate: "d",
      nudge: false,
      wrapUp: false,
    });
    expect(first).toContain("The workflow was triggered");
    const later = buildSteeringMessage({
      run: run(),
      turnIndex: 3,
      currentDate: "d",
      nudge: false,
      wrapUp: false,
    });
    expect(later).toContain("Continue the run.");
  });
});
