import { describe, expect, test } from "bun:test";
import { analyzeChains } from "../../src/services/trajectory/chains";
import type { TrajectoryStep } from "../../src/services/trajectory/extract";

/**
 * "Those five calls should have been one" — decided by a rule, not a model.
 *
 * Each case below is a pair of cells and one question: did the second cell use
 * something it could only have learned from the first? That is the difference
 * between a continuation, which one script can replace, and a decision, which
 * fusing would delete.
 */

let nextIndex = 0;

const cell = (
  code: string,
  output: unknown,
  taskKey?: string,
): TrajectoryStep => ({
  index: nextIndex++,
  messageIndex: 0,
  toolName: "python",
  toolCallId: `c${nextIndex.toString()}`,
  input: { code },
  inputHash: `h${nextIndex.toString()}`,
  output,
  outputHash: `o${nextIndex.toString()}`,
  outputChars: JSON.stringify(output)?.length ?? 0,
  source: code,
  ...(taskKey !== undefined ? { taskKey } : {}),
});

const chainOf = (
  ...steps: TrajectoryStep[]
): ReturnType<typeof analyzeChains> => analyzeChains(steps);

describe("analyzeChains — what breaks a chain", () => {
  test("a literal the cell could only have learned from the previous output", () => {
    // The model listed the folders, read `f-931ba7c` off the result, and used
    // it. It looked before it decided. Fusing the two cells would take that
    // look away, and the fused script would run against whatever the first
    // folder happened to be.
    nextIndex = 0;
    const analysis = chainOf(
      cell("pbyp.list_folders()", { folders: ["f-9031ba7c", "f-40e2"] }),
      cell("pbyp.get_folder('f-9031ba7c')", { name: "Invoices" }),
    );
    expect(analysis.fusableJoins).toBe(0);
    expect(analysis.joins[0]?.carried).toEqual(["f-9031ba7c"]);
    expect(analysis.callsRemovable).toBe(0);
  });

  test("a literal the cell already had is not something it learned", () => {
    // `folders` appears in the first cell's OUTPUT, but it was in its own
    // source first. Counting it would mark almost every pair as a decision and
    // report that nothing is ever fusable — the failure mode that would
    // silently kill this whole tier.
    nextIndex = 0;
    const analysis = chainOf(
      cell("pbyp.describe_collection('folders')", {
        collection: "folders",
        fields: ["name"],
      }),
      cell("pbyp.list('folders', limit=50)", { rows: [] }),
    );
    expect(analysis.fusableJoins).toBe(1);
    expect(analysis.callsRemovable).toBe(1);
  });

  test("a short literal is noise, not a binding", () => {
    // `id` collides with something in nearly every JSON payload.
    nextIndex = 0;
    const analysis = chainOf(
      cell("probe()", { id: 42, ok: true }),
      cell("use('id', 42)", {}),
    );
    expect(analysis.fusableJoins).toBe(1);
  });

  test("digits inside a quoted string are part of it, not a binding of their own", () => {
    // `2024` appears in the first output and inside the second cell's string.
    // Reading it as a binding of its own invents a decision that never
    // happened and reports a fusable pair as a broken one — and the same slip
    // splits `'f-9031ba7c'` into two findings.
    nextIndex = 0;
    const analysis = chainOf(
      cell("summary()", { year: 2024, rows: 12 }),
      cell("load('ref-2024-batch')", {}),
    );
    expect(analysis.joins[0]?.carried).toEqual([]);
    expect(analysis.fusableJoins).toBe(1);
  });

  test("a task boundary breaks the chain whatever the literals say", () => {
    // Tasks are what the team wrote down as separate intents. A chain that
    // crossed one would propose fusing work the playbook split on purpose.
    nextIndex = 0;
    const analysis = chainOf(
      cell("step_a()", {}, "gather"),
      cell("step_b()", {}, "report"),
    );
    expect(analysis.joins).toHaveLength(0);
    expect(analysis.chains).toHaveLength(0);
  });
});

describe("analyzeChains — the literal the model made up", () => {
  // Measured on a real workflow before this existed: 98% of adjacent pairs
  // reported as fusable, because sixty-six web searches whose queries the
  // model had invented on the spot each carried nothing from the one before.
  // They carried nothing because they came from its own reasoning.
  const search = (query: string, output: unknown): TrajectoryStep => ({
    ...cell("", output),
    toolName: "searchWeb",
    source: undefined,
    input: { queries: [query] },
  });

  test("without the procedure's vocabulary, an invention reads as a continuation", () => {
    nextIndex = 0;
    const analysis = chainOf(
      search("competitors of acme", { results: [] }),
      search("acme pricing model", { results: [] }),
    );
    expect(analysis.fusableJoins).toBe(1);
    expect(analysis.joins[0]?.invented).toEqual([]);
  });

  test("with it, a literal seen in no other run breaks the chain", () => {
    nextIndex = 0;
    const steps = [
      search("competitors of acme", { results: [] }),
      search("acme pricing model", { results: [] }),
    ];
    const analysis = analyzeChains(steps, {
      stableLiterals: new Set(["competitors of acme"]),
    });
    expect(analysis.joins[0]?.invented).toEqual(["acme pricing model"]);
    expect(analysis.fusableJoins).toBe(0);
  });

  test("a constant of the workflow stays fusable", () => {
    // The whole point of the distinction: a literal hardcoded in the procedure
    // appears in every run, so it goes into the script and nothing is lost.
    nextIndex = 0;
    const steps = [
      search("weekly market scan", { results: [] }),
      search("weekly market scan", { results: [] }),
    ];
    const analysis = analyzeChains(steps, {
      stableLiterals: new Set(["weekly market scan"]),
    });
    expect(analysis.joins[0]?.invented).toEqual([]);
    expect(analysis.fusableJoins).toBe(1);
  });
});

describe("analyzeChains — what it proposes", () => {
  test("a run of continuations becomes one chain", () => {
    nextIndex = 0;
    const analysis = chainOf(
      cell("import pandas as pd", {}),
      cell("df = pd.DataFrame()", {}),
      cell("df.describe()", { count: 0 }),
    );
    expect(analysis.chains).toHaveLength(1);
    expect(analysis.chains[0]?.stepIndexes).toEqual([0, 1, 2]);
    expect(analysis.callsRemovable).toBe(2);
  });

  test("a chain is cut at the decision, not around it", () => {
    nextIndex = 0;
    const analysis = chainOf(
      cell("setup()", {}),
      cell("probe()", { token: "tk-8812aa" }),
      cell("use('tk-8812aa')", {}),
      cell("finish()", {}),
    );
    // [0,1] continue; 1→2 is the decision; [2,3] continue again.
    expect(analysis.chains.map((c) => c.stepIndexes)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(analysis.callsRemovable).toBe(2);
  });
});

describe("analyzeChains — a chain that writes is not counted", () => {
  test("a write marker in the source keeps the chain out of the estimate", () => {
    nextIndex = 0;
    const analysis = chainOf(
      cell("rows = build()", {}),
      cell("pbyp.records.bulk_create(rows)", { created: 3 }),
    );
    expect(analysis.fusableJoins).toBe(1);
    expect(analysis.chains[0]?.readOnly).toBe(false);
    expect(analysis.callsRemovable).toBe(0);
  });

  test("a call parked on an approval is a write, whatever its source says", () => {
    // The source of a gated call says nothing useful — the write went out
    // through the plan runner. What is unambiguous is the answer that came
    // back.
    nextIndex = 0;
    const analysis = chainOf(
      cell("prepare()", {}),
      cell("submit()", { status: "approval_pending", approvalId: "ap-1" }),
    );
    expect(analysis.chains[0]?.readOnly).toBe(false);
    expect(analysis.callsRemovable).toBe(0);
  });

  test("closing a task is the protocol, not work a script could do", () => {
    // Measured against a real workflow: a two-call task (`querySql` then
    // `completeTask`) reported as a fusable chain removing one call, which
    // would have meant a script closing its own task. `completeTask` commits
    // the run's task states — it is a write, and this module already knows the
    // protocol because it reads that output to follow the task cursor.
    nextIndex = 0;
    const query = cell("rows = query()", { rows: [] });
    const close: TrajectoryStep = {
      ...cell("", { closedTask: { key: "gather" } }),
      toolName: "completeTask",
      source: undefined,
      input: { outcome: "completed", summary: "done" },
    };
    const analysis = analyzeChains([query, close]);
    expect(analysis.fusableJoins).toBe(1);
    expect(analysis.chains[0]?.readOnly).toBe(false);
    expect(analysis.callsRemovable).toBe(0);
  });

  test("a tool the caller names as writing is believed", () => {
    // `shared` cannot import the AI package's tool registry, so the caller
    // that has it passes it in rather than this module keeping a list that
    // goes stale in silence.
    nextIndex = 0;
    const steps = [cell("a()", {}), cell("b()", {})];
    const analysis = analyzeChains(steps, {
      writeTools: new Set(["python"]),
    });
    expect(analysis.chains[0]?.readOnly).toBe(false);
  });
});

describe("analyzeChains — scoping", () => {
  test("onlyTools asks the question of consecutive cells of one kind", () => {
    nextIndex = 0;
    const a = cell("first()", {});
    const readCall: TrajectoryStep = {
      ...cell("", {}),
      toolName: "read",
      source: undefined,
      input: { file_path: "skills/x/SKILL.md" },
      filePath: "skills/x/SKILL.md",
    };
    const b = cell("second()", {});
    const scoped = analyzeChains([a, readCall, b], {
      onlyTools: new Set(["python"]),
    });
    // With the read filtered out, the two cells are adjacent and continue.
    expect(scoped.chains[0]?.stepIndexes).toEqual([a.index, b.index]);
    const unscoped = analyzeChains([a, readCall, b]);
    expect(unscoped.chains[0]?.stepIndexes).toEqual([
      a.index,
      readCall.index,
      b.index,
    ]);
  });
});
