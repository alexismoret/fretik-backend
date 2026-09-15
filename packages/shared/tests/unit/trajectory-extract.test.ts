import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  extractTrajectory,
  summarizeTrajectory,
} from "../../src/services/trajectory/extract";

/**
 * The trajectory ledger, read back from the shape a run actually persists.
 *
 * The fixtures below are the real thing in miniature: a workflow run that
 * reads two skill files, discovers a schema, fails a cell, retries the SAME
 * cell, and closes two tasks. Every number the plan's measurement tier leans
 * on is one of those events counted.
 */

interface BuildToolPart {
  toolName: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  state?: "output-available" | "output-error" | "input-available";
}

/**
 * Cast through `unknown` once, at the fixture boundary: the AI SDK models
 * `UIMessage['parts']` as a per-tool discriminated union that a structural
 * literal cannot satisfy. Same localisation as the compaction suites —
 * production code stays cast-free.
 */
const assistant = (id: string, parts: BuildToolPart[]): UIMessage => ({
  id,
  role: "assistant",
  parts: parts.map((p) => ({
    type: `tool-${p.toolName}`,
    toolCallId: p.toolCallId ?? `${id}-${p.toolName}`,
    state: p.state ?? "output-available",
    input: p.input,
    output: p.output,
  })) as unknown as UIMessage["parts"],
});

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const read = (path: string, id: string): BuildToolPart => ({
  toolName: "read",
  toolCallId: id,
  input: { file_path: path },
  output: { content: "…" },
});

const python = (
  code: string,
  id: string,
  output: unknown = { stdout: "ok" },
): BuildToolPart => ({
  toolName: "python",
  toolCallId: id,
  input: { code },
  output,
});

/** A run that reads its skills, discovers a schema, stumbles, and recovers. */
const RUN: UIMessage[] = [
  user("u1", "Work on task `gather`."),
  assistant("a1", [
    read("skills/pbyp/SKILL.md", "c1"),
    read("skills/pbyp/references/collections.md", "c2"),
    python("from fretik_apps import pbyp\npbyp.whoami()", "c3"),
    python("pbyp.describe_collection('folders')", "c4", {
      error: "kernel died",
      code: "PYTHON_ERROR",
    }),
    python("pbyp.describe_collection('folders')", "c5"),
    {
      toolName: "completeTask",
      toolCallId: "c6",
      input: { outcome: "completed", summary: "Inventory built." },
      output: { closedTask: { key: "gather" }, nextTask: { key: "report" } },
    },
  ]),
  assistant("a2", [
    python("wb.save('outputs/report.xlsx')", "c7"),
    {
      toolName: "completeTask",
      toolCallId: "c8",
      input: { outcome: "completed", summary: "Report written." },
      output: { closedTask: { key: "report" }, allTasksDone: true },
    },
  ]),
];

describe("extractTrajectory", () => {
  test("reads every finished call, in dispatch order, across messages", () => {
    const steps = extractTrajectory(RUN);
    expect(steps.map((s) => s.toolCallId)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
    ]);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The way back to the transcript: which message held the call.
    expect(steps[0]?.messageIndex).toBe(1);
    expect(steps[6]?.messageIndex).toBe(2);
  });

  test("attributes the calls before the first completeTask to the task it closed", () => {
    // Nothing tells the extractor which task opened the run — `completeTask`
    // takes no key, it closes whatever is open. Its RESULT names the task, so
    // the attribution is derived from what the run did rather than supplied.
    const steps = extractTrajectory(RUN);
    expect(steps.slice(0, 6).map((s) => s.taskKey)).toEqual([
      "gather",
      "gather",
      "gather",
      "gather",
      "gather",
      "gather",
    ]);
    expect(steps.slice(6).map((s) => s.taskKey)).toEqual(["report", "report"]);
  });

  test("an explicit first task seeds the attribution when no task ever closes", () => {
    const partial = [user("u1", "go"), assistant("a1", [read("a.md", "c1")])];
    expect(extractTrajectory(partial)[0]?.taskKey).toBeUndefined();
    expect(
      extractTrajectory(partial, { initialTaskKey: "gather" })[0]?.taskKey,
    ).toBe("gather");
  });

  test("a call that never came back is not work done", () => {
    // An `input-available` part is a call the turn was interrupted on. Counting
    // it would make a crashed run look busier than one that finished.
    const steps = extractTrajectory([
      assistant("a1", [
        read("skills/x/SKILL.md", "c1"),
        { toolName: "python", toolCallId: "c2", state: "input-available" },
      ]),
    ]);
    expect(steps.map((s) => s.toolCallId)).toEqual(["c1"]);
  });

  test("both failure shapes are read: the envelope and the failed part", () => {
    const steps = extractTrajectory([
      assistant("a1", [
        python("boom", "c1", { error: "nope", code: "PYTHON_ERROR" }),
        { toolName: "python", toolCallId: "c2", state: "output-error" },
      ]),
    ]);
    expect(steps[0]?.errorCode).toBe("PYTHON_ERROR");
    expect(steps[1]?.errorCode).toBe("TOOL_PART_ERROR");
  });

  test("identical calls hash identically whatever the key order", () => {
    // Redundancy is the signal, and two calls that differ only in how the
    // model happened to serialise its arguments are one call made twice.
    const steps = extractTrajectory([
      assistant("a1", [
        { toolName: "listRecords", toolCallId: "c1", input: { a: 1, b: 2 } },
        { toolName: "listRecords", toolCallId: "c2", input: { b: 2, a: 1 } },
      ]),
    ]);
    expect(steps[0]?.inputHash).toBe(steps[1]?.inputHash ?? "");
  });

  test("malformed parts are data, not a crash", () => {
    // `parts` is jsonb: a row written by an older shape of the code has to be
    // survivable, because the ledger is read over months of history.
    const broken: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        null,
        "not a part",
        { type: 42 },
        { type: "tool-python", state: "output-available" },
        { type: "text", text: "hello" },
      ] as unknown as UIMessage["parts"],
    };
    const steps = extractTrajectory([broken]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.toolName).toBe("python");
    expect(steps[0]?.source).toBeUndefined();
  });
});

describe("summarizeTrajectory", () => {
  const summary = summarizeTrajectory(extractTrajectory(RUN));

  test("counts where the calls went", () => {
    expect(summary.totalCalls).toBe(8);
    expect(summary.perTool).toEqual({ read: 2, python: 4, completeTask: 2 });
  });

  test("counts the re-reading the plan exists to remove", () => {
    expect(summary.skillReads).toEqual({ calls: 2, distinctFiles: 2 });
  });

  test("counts a repeated call once as surplus, not twice as work", () => {
    // `describe_collection('folders')` ran twice with byte-identical source:
    // one useful call, one repeat. Schema rediscovery is the single largest
    // family of removable calls measured anywhere in the literature.
    expect(summary.redundantCalls).toBe(1);
  });

  test("separates a failure from a failure the run recovered from", () => {
    expect(summary.errorCalls).toBe(1);
    expect(summary.perErrorCode).toEqual({ PYTHON_ERROR: 1 });
    expect(summary.errorThenRetry).toBe(1);
    expect(summary.pythonCells.recoveredAfterError).toBe(1);
  });

  test("rolls the run up per task, in the order the tasks were worked", () => {
    expect(summary.perTask.map((t) => t.taskKey)).toEqual(["gather", "report"]);
    const gather = summary.perTask[0];
    expect(gather?.calls).toBe(6);
    expect(gather?.skillReadCalls).toBe(2);
    expect(gather?.pythonCells).toBe(3);
    expect(gather?.errorCalls).toBe(1);
    expect(summary.perTask[1]?.calls).toBe(2);
  });

  test("a run with no recipe says so", () => {
    expect(summary.recipeUsed).toBe(false);
  });
});

describe("recipeUsed — the deterministic 'the artifact was used' gate", () => {
  test("a recipe read counts", () => {
    const steps = extractTrajectory([
      assistant("a1", [read("recipes/gather/run-3.py", "c1")]),
    ]);
    expect(summarizeTrajectory(steps).recipeUsed).toBe(true);
  });

  test("a recipe executed without being read counts too", () => {
    // The doctrine tells the agent never to transcribe tool output into
    // another call: it runs the file in place. A gate that only watched `read`
    // would score the intended behaviour as a miss.
    const steps = extractTrajectory([
      assistant("a1", [
        python("exec(open('recipes/gather/run-3.py').read())", "c1"),
      ]),
    ]);
    expect(summarizeTrajectory(steps).recipeUsed).toBe(true);
  });

  test("a skill read is not a recipe use", () => {
    const steps = extractTrajectory([
      assistant("a1", [read("skills/pbyp/SKILL.md", "c1")]),
    ]);
    expect(summarizeTrajectory(steps).recipeUsed).toBe(false);
  });
});
