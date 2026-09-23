import { describe, expect, test } from "bun:test";
import { DECISION_POINT_KEYS } from "../../src/decisions/keys";
import { DECISION_POINTS, familyOf } from "../../src/decisions/points";

/**
 * Invariants of the decision-point registry.
 *
 * Each rule is something a reviewer would miss in a diff and a user would
 * pay for in production: a threshold no answer can sit on, a hot-path point
 * switched on with no evidence, a redactable point with nothing to redact.
 */

const points = Object.values(DECISION_POINTS);

/** Answers are rounded to two decimals, so a bar must be one too. */
const isCentesimal = (value: number): boolean =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

describe("the decision-point registry", () => {
  test("every key has exactly one spec, under its own key", () => {
    expect(Object.keys(DECISION_POINTS).sort()).toEqual(
      [...DECISION_POINT_KEYS].sort(),
    );
    for (const [key, spec] of Object.entries(DECISION_POINTS)) {
      expect(key).toBe(spec.key);
    }
  });

  test("every threshold is a centesimal strictly inside (0, 1)", () => {
    // 0 and 1 are not thresholds, they are switches — and a switch belongs in
    // `mode`, where a reader looks for one.
    for (const spec of points) {
      for (const family of Object.values(spec.families)) {
        expect(family.threshold).toBeGreaterThan(0);
        expect(family.threshold).toBeLessThan(1);
        expect(isCentesimal(family.threshold)).toBe(true);
        if (family.minChosenProbability !== undefined) {
          expect(family.kind).toBe("choice");
          expect(isCentesimal(family.minChosenProbability)).toBe(true);
        }
      }
    }
  });

  test("a confidence signal is only asked of a choice or a score", () => {
    // A boolean answer carries no confidence: its number IS the belief.
    for (const spec of points) {
      for (const family of Object.values(spec.families)) {
        if (family.signal === "confidence") {
          expect(family.kind).not.toBe("boolean");
        }
      }
    }
  });

  test("a hot-path point may not default to `on` without evidence", () => {
    for (const spec of points) {
      if (spec.path === "hot" && spec.defaultMode === "on") {
        expect(spec.evalGate.evidence).toBeDefined();
      }
      if (spec.path === "hot") expect(spec.fallbackTransport).toBe(false);
    }
  });

  test("a redactable point declares what it would redact", () => {
    for (const spec of points) {
      if (spec.egress === "redactable") {
        expect(spec.state.content.length).toBeGreaterThan(0);
      }
      if (spec.egress === "metadata") {
        expect(spec.state.content).toEqual([]);
      }
    }
  });

  test("every content key is also admitted", () => {
    // A content key nobody admits is a redaction rule that guards nothing,
    // which reads as protection in review and is not.
    for (const spec of points) {
      for (const key of spec.state.content) {
        expect(spec.state.admit).toContain(key);
      }
    }
  });

  test("the gate never sends an id", () => {
    // A uuid carries nothing a criterion can be about, and every token of
    // noise in the state costs accuracy on the tokens that matter.
    const gate = DECISION_POINTS["workflow.gate"];
    for (const key of gate.state.admit) expect(key).not.toMatch(/Id$/);
    expect(gate.state.admit).toContain("eventType");
  });

  test("the gate's content list covers every sensitive fact, fixed and dynamic", () => {
    const gate = DECISION_POINTS["workflow.gate"];
    expect(gate.state.content).toContain("documentSummary");
    expect(gate.state.content).toContain("customFields.");
    expect(gate.state.content).toContain("payload.");
  });
});

describe("familyOf", () => {
  test("the family is the prefix before the first colon", () => {
    expect(familyOf("wf:0199-abc")).toBe("wf");
    expect(familyOf("rel:c1:extra")).toBe("rel");
  });

  test("an id with no colon is its own family", () => {
    expect(familyOf("folder")).toBe("folder");
  });
});
