import type { Workflow } from "@fretik/shared/db/schema";
import type {
  DecisionAnswer,
  DecisionAnswered,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
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

const workflow = (over: Partial<Workflow>): Workflow => ({
  id: "w1",
  organizationId: "org-1",
  teamId: "team-1",
  userId: null,
  name: "Invoice filing",
  description: "",
  icon: null,
  color: null,
  status: "active",
  triggerType: "event",
  triggerConfig: {},
  triggerCriterion: "The document is a supplier invoice.",
  playbook: {
    goal: "File supplier invoices",
    tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
  },
  autonomy: "approval_required",
  modelProfileKey: null,
  reasoningLevel: null,
  limits: {},
  notifications: {
    emailOnCompletion: false,
    notifyTriggeredBy: false,
    recipientUserIds: [],
  },
  externalAppConnectionIds: [],
  triggerScheduleId: null,
  formToken: null,
  pausedReason: null,
  createdByUserId: null,
  lastRunAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

const answered = (
  answers: Record<string, DecisionAnswer>,
  over: Partial<DecisionAnswered> = {},
): DecisionResponse => ({
  status: "answered",
  point: "workflow.gate",
  policy: {
    mode: "on",
    questionVersion: 2,
    thresholds: { wf: 0.15 },
    minChosenProbability: {},
  },
  answers,
  missing: [],
  transport: "openrouter",
  latencyMs: 120,
  ...over,
});

const now = new Date("2026-09-20T10:00:00Z");
const id = gateQuestionId("w1");

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
    const question = buildGateQuestions([workflow({})])[id];
    expect(question?.type).toBe("boolean");
    expect(question?.instructions).toContain("Invoice filing");
    expect(question?.instructions).toContain("File supplier invoices");
    expect(question?.instructions).toContain("supplier invoice");
  });

  test("the criteria are neutral: the asymmetry lives in the threshold alone", () => {
    // Version 1 told the model to prefer true on doubt AND sat behind a low
    // threshold. Asymmetric twice, P(true) stopped meaning anything that could
    // be calibrated.
    const question = buildGateQuestions([workflow({})])[id];
    const criteria = question?.type === "boolean" ? question.criteria : null;
    expect(criteria?.true).not.toContain("doubt");
    expect(criteria?.false).toBeDefined();
  });
});

describe("readGateVerdicts", () => {
  test("a confident negative is the ONLY way a launch is refused", () => {
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered({ [id]: { type: "boolean", probability: 0.03 } }),
      now,
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
      answered({ [id]: { type: "boolean", probability: 0.15 } }),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("allowed");
  });

  test("the threshold is the one the SERVICE echoed, not a local constant", () => {
    // An operator override set on the AI service must reach this worker
    // without being set twice.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered(
        { [id]: { type: "boolean", probability: 0.2 } },
        {
          policy: {
            mode: "on",
            questionVersion: 2,
            thresholds: { wf: 0.3 },
            minChosenProbability: {},
          },
        },
      ),
      now,
    );
    expect(verdict?.allowed).toBe(false);
    expect(verdict?.decision?.threshold).toBe(0.3);
  });

  test("in shadow, a negative is recorded and NOT acted on", () => {
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered(
        { [id]: { type: "boolean", probability: 0.02 } },
        {
          policy: {
            mode: "shadow",
            questionVersion: 2,
            thresholds: { wf: 0.15 },
            minChosenProbability: {},
          },
        },
      ),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("allowed");
    expect(verdict?.decision?.shadow).toBe(true);
    expect(verdict?.decision?.probability).toBe(0.02);
  });

  test("an unreachable engine falls open, and says so", () => {
    // The decision service being off, slow or broken must never stop a
    // workflow. `fell_open` is recorded rather than silently allowed, because
    // a run of these means the gate is not being applied — an incident that
    // would otherwise look exactly like healthy traffic.
    const [verdict] = readGateVerdicts([workflow({})], null, now);
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
    expect(verdict?.decision?.reason).toBe("unreachable");
  });

  test("a skipped point falls open with the skip's own reason", () => {
    const [verdict] = readGateVerdicts(
      [workflow({})],
      { status: "skipped", point: "workflow.gate", reason: "off" },
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.reason).toBe("off");
  });

  test("a question the engine could not answer falls open with its reason", () => {
    // Partial outages are partial: this workflow falls open on its own
    // missing answer while its siblings in the same request are decided.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered({}, { missing: [{ id, reason: "timeout" }] }),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
    expect(verdict?.decision?.reason).toBe("timeout");
  });

  test("an answer of the wrong TYPE falls open rather than being coerced", () => {
    // Reading a score where a boolean was asked means a protocol drift or a
    // bug; coercing one into the other could refuse a launch on a number that
    // means something else entirely.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered({ [id]: { type: "score", score: 0 } }),
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision?.outcome).toBe("fell_open");
  });

  test("a workflow with no criterion is allowed and records NO decision", () => {
    const [verdict] = readGateVerdicts(
      [workflow({ triggerCriterion: null })],
      null,
      now,
    );
    expect(verdict?.allowed).toBe(true);
    expect(verdict?.decision).toBeNull();
  });

  test("the criterion and the question version are snapshotted", () => {
    // Editing the workflow afterwards must not rewrite what a past decision
    // was made against, and two wordings never share a calibration.
    const [verdict] = readGateVerdicts(
      [workflow({})],
      answered({ [id]: { type: "boolean", probability: 0.9 } }),
      now,
    );
    expect(verdict?.decision?.criterion).toBe(
      "The document is a supplier invoice.",
    );
    expect(verdict?.decision?.questionVersion).toBe(2);
  });

  test("cost, latency and transport ride every verdict from one call", () => {
    // One decision covers N workflows, so the call's cost belongs on each of
    // its verdicts, and the transport decides whether any of them may ever be
    // used to calibrate.
    const verdicts = readGateVerdicts(
      [workflow({ id: "w1" }), workflow({ id: "w2" })],
      answered(
        {
          [gateQuestionId("w1")]: { type: "boolean", probability: 0.9 },
          [gateQuestionId("w2")]: { type: "boolean", probability: 0.01 },
        },
        {
          latencyMs: 90,
          costUsd: 0.00008,
          modelId: "typesafe/jev-1.13",
          transport: "gateway",
        },
      ),
      now,
    );
    expect(verdicts.map((v) => v.allowed)).toEqual([true, false]);
    for (const verdict of verdicts) {
      expect(verdict.decision?.latencyMs).toBe(90);
      expect(verdict.decision?.costUsd).toBe(0.00008);
      expect(verdict.decision?.transport).toBe("gateway");
    }
  });
});
