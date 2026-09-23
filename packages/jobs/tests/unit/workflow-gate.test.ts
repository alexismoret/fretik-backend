import type { Workflow } from "@fretik/shared/db/schema";
import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  buildGateQuestions,
  gateQuestionId,
  readGateVerdicts,
} from "../../src/lib/workflow-gate";

/**
 * The trigger gate's decisions.
 *
 * Every rule here exists to keep ONE failure mode impossible: a workflow that
 * quietly stops firing. A run that should not have started is visible — it
 * lands as `not_applicable` and anyone can count it. A run that should have
 * started and did not is invisible until a client asks why their document was
 * never processed, and by then it has been weeks.
 *
 * So the assertions below are mostly about the paths that must ALLOW. There
 * is exactly one way to refuse a launch, and these tests pin every other
 * branch open.
 */

const workflow = (over: Partial<Workflow>): Workflow =>
  ({
    id: "w1",
    organizationId: "org-1",
    teamId: "team-1",
    name: "Invoice filing",
    triggerCriterion: "The document is a supplier invoice.",
    playbook: { goal: "File supplier invoices", tasks: [] },
    ...over,
  }) as Workflow;

const response = (answers: DecisionResponse["answers"]): DecisionResponse => ({
  answers,
  latencyMs: 120,
});

describe("buildGateQuestions", () => {
  test("a workflow with no criterion is never asked about", () => {
    // This is the migration path AND the per-workflow off switch: a NULL
    // criterion means the workflow fires exactly as it did before the gate
    // existed, so every workflow that predates this feature is untouched.
    expect(buildGateQuestions([workflow({ triggerCriterion: null })])).toEqual(
      {},
    );
  });

  test("a blank criterion is treated as no criterion, not as an empty rule", () => {
    // An empty rule would be judged against nothing and could refuse anything.
    expect(buildGateQuestions([workflow({ triggerCriterion: "   " })])).toEqual(
      {},
    );
  });

  test("the question carries the workflow's name and goal, not just the clause", () => {
    // A criterion is written as a clause ("the document is an invoice"), and a
    // clause alone does not say what it is a clause OF.
    const questions = buildGateQuestions([workflow({})]);
    const question = questions[gateQuestionId("w1")];
    expect(question?.type).toBe("boolean");
    expect(question?.instructions).toContain("Invoice filing");
    expect(question?.instructions).toContain("File supplier invoices");
    expect(question?.instructions).toContain("supplier invoice");
  });

  test("the true branch tells the model to prefer true under doubt", () => {
    const questions = buildGateQuestions([workflow({})]);
    const question = questions[gateQuestionId("w1")];
    expect(question?.type === "boolean" && question.criteria?.true).toContain(
      "doubt",
    );
  });
});

describe("readGateVerdicts", () => {
  const now = new Date("2026-09-20T10:00:00Z");

  test("a confident negative is the ONLY way a launch is refused", () => {
    const [verdict] = readGateVerdicts(
      [workflow({})],
      response({
        [gateQuestionId("w1")]: { type: "boolean", probability: 0.03 },
      }),
      now,
      0.15,
    );
    expect(verdict?.allowed).toBe(false);
    expect(verdict?.decision?.outcome).toBe("filtered");
    expect(verdict?.decision?.probability).toBe(0.03);
    expect(verdict?.decision?.threshold).toBe(0.15);
  });

  test("exactly at the threshold, the launch proceeds", () => {
    // The bar is "clears it", not "beats it" — a boundary that refused would
    // make the documented threshold mean something other than what it says.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      response({
        [gateQuestionId("w1")]: { type: "boolean", probability: 0.15 },
      }),
      now,
      0.15,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("allowed");
  });

  test("no decision at all falls open, and says so", () => {
    // The decision service being off, slow or broken must never stop a
    // workflow. `fell_open` is recorded rather than silently allowed, because
    // a run of these means the gate is not being applied — an incident that
    // would otherwise look exactly like healthy traffic.
    const [verdict] = readGateVerdicts([workflow({})], null, now);
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
    expect(verdict?.decision?.reason).toBe("no decision available");
  });

  test("an answer for somebody else's question falls open", () => {
    // A response that came back without this workflow's id decided nothing
    // about it, whatever it decided about the others.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      response({ "wf:other": { type: "boolean", probability: 0.9 } }),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
    expect(verdict?.decision?.reason).toBe("no answer for this workflow");
  });

  test("an answer of the wrong TYPE falls open rather than being coerced", () => {
    // Reading a score where a boolean was asked means a protocol drift or a
    // bug; coercing one into the other would hide both, and could refuse a
    // launch on a number that means something else entirely.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      response({ [gateQuestionId("w1")]: { type: "score", score: 0 } }),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
  });

  test("a workflow with no criterion is allowed and records NO decision", () => {
    // Not "allowed by the gate" — never gated. The absent decision on the run
    // row is what says so.
    const [verdict] = readGateVerdicts(
      [workflow({ triggerCriterion: null })],
      null,
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision).toBeNull();
  });

  test("the criterion is snapshotted into the decision", () => {
    // Editing the workflow afterwards must not rewrite what a past decision
    // was made against.
    const [verdict] = readGateVerdicts(
      [workflow({ triggerCriterion: "The document is a supplier invoice." })],
      response({
        [gateQuestionId("w1")]: { type: "boolean", probability: 0.9 },
      }),
      now,
    );
    expect(verdict?.decision?.criterion).toBe(
      "The document is a supplier invoice.",
    );
  });

  test("cost and latency ride every verdict from one call", () => {
    // One decision covers N workflows, so the call's cost belongs on each of
    // its verdicts — otherwise a gated event's true price is unrecoverable.
    const verdicts = readGateVerdicts(
      [workflow({ id: "w1" }), workflow({ id: "w2" })],
      {
        answers: {
          [gateQuestionId("w1")]: { type: "boolean", probability: 0.9 },
          [gateQuestionId("w2")]: { type: "boolean", probability: 0.01 },
        },
        latencyMs: 90,
        costUsd: 0.00008,
        modelId: "typesafe/jev-1.13",
      },
      now,
    );
    expect(verdicts.map((v) => v.allowed)).toEqual([true, false]);
    for (const verdict of verdicts) {
      expect(verdict.decision?.latencyMs).toBe(90);
      expect(verdict.decision?.costUsd).toBe(0.00008);
      expect(verdict.decision?.modelId).toBe("typesafe/jev-1.13");
    }
  });
});
