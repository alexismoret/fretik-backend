import { describe, expect, test } from "bun:test";
import {
  chosenOf,
  parseDecisionOverrides,
  probabilityOf,
  resolvePolicy,
  scoreOf,
  thresholdFor,
} from "../../src/decisions/policy";

/**
 * How a point is actually run: registry defaults, operator overrides, and
 * the content-egress stance.
 */

describe("parseDecisionOverrides", () => {
  test("unset or blank means no overrides", () => {
    expect(parseDecisionOverrides(undefined)).toEqual({});
    expect(parseDecisionOverrides("  ")).toEqual({});
  });

  test("a valid override parses", () => {
    expect(
      parseDecisionOverrides(
        '{"workflow.gate":{"mode":"off"},"drive.file":{"thresholds":{"folder":0.85}}}',
      ),
    ).toEqual({
      "workflow.gate": { mode: "off" },
      "drive.file": { thresholds: { folder: 0.85 } },
    });
  });

  test("malformed JSON is a boot failure, not a silent no-op", () => {
    expect(() => parseDecisionOverrides("{workflow.gate")).toThrow(
      "not valid JSON",
    );
  });

  test("an unknown point is refused", () => {
    // An override that matches nothing is an operator believing a gate is
    // off while it keeps deciding.
    expect(() =>
      parseDecisionOverrides('{"workflow.gat":{"mode":"off"}}'),
    ).toThrow("invalid");
  });

  test("an unknown question family is refused", () => {
    expect(() =>
      parseDecisionOverrides('{"workflow.gate":{"thresholds":{"folder":0.5}}}'),
    ).toThrow('no question family "folder"');
  });

  test("an unknown field is refused", () => {
    expect(() =>
      parseDecisionOverrides('{"workflow.gate":{"threshold":0.5}}'),
    ).toThrow("invalid");
  });
});

describe("resolvePolicy", () => {
  test("defaults come from the registry", () => {
    const policy = resolvePolicy("workflow.gate", {
      overrides: {},
      contentEgress: true,
    });
    expect(policy.mode).toBe("on");
    expect(policy.echo.thresholds).toEqual({ wf: 0.15 });
    expect(policy.runnable).toBe(true);
    expect(policy.redactContent).toBe(false);
  });

  test("an override moves the mode and the bar, and the echo carries both", () => {
    const policy = resolvePolicy("workflow.gate", {
      overrides: {
        "workflow.gate": { mode: "shadow", thresholds: { wf: 0.3 } },
      },
      contentEgress: true,
    });
    expect(policy.echo.mode).toBe("shadow");
    expect(policy.echo.thresholds).toEqual({ wf: 0.3 });
  });

  test("a choice point echoes its minimum chosen probability", () => {
    const policy = resolvePolicy("drive.file", {
      overrides: {},
      contentEgress: true,
    });
    expect(policy.echo.minChosenProbability).toEqual({ folder: 0.5 });
  });

  test("with content egress off, a redactable point redacts instead of stopping", () => {
    const policy = resolvePolicy("workflow.gate", {
      overrides: {},
      contentEgress: false,
    });
    expect(policy.runnable).toBe(true);
    expect(policy.redactContent).toBe(true);
  });
});

describe("reading answers", () => {
  test("a boolean reads as its probability, anything else as nothing", () => {
    expect(probabilityOf({ type: "boolean", probability: 0.4 })).toBe(0.4);
    expect(probabilityOf({ type: "score", score: 1 })).toBeNull();
    expect(probabilityOf(undefined)).toBeNull();
  });

  test("a choice reads its winner's probability and the confidence", () => {
    expect(
      chosenOf({
        type: "choice",
        choice: "a",
        probabilities: { a: 0.7, b: 0.3 },
        confidence: 0.6,
      }),
    ).toEqual({ choice: "a", probability: 0.7, confidence: 0.6 });
  });

  test("a missing confidence is null, never zero", () => {
    // Not reported is not low. The gateway reports none today.
    expect(chosenOf({ type: "choice", choice: "a" })).toEqual({
      choice: "a",
      probability: null,
      confidence: null,
    });
  });

  test("a score reads its position and confidence", () => {
    expect(scoreOf({ type: "score", score: 1.4, confidence: 0.8 })).toEqual({
      score: 1.4,
      confidence: 0.8,
    });
  });

  test("the bar is looked up by question family", () => {
    expect(
      thresholdFor(
        {
          mode: "on",
          questionVersion: 2,
          thresholds: { wf: 0.15 },
          minChosenProbability: {},
        },
        "wf:0199-abc",
      ),
    ).toBe(0.15);
  });
});
