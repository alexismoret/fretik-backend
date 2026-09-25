import { describe, expect, test } from "bun:test";
import { DECISION_POINT_KEYS } from "../../src/decisions/keys";
import { DECISION_POINTS, familyOf } from "../../src/decisions/points";

/**
 * Invariants of the decision-point registry.
 *
 * Each rule is something a reviewer would miss in a diff and a user would
 * pay for in production: a threshold no answer can sit on, a hot-path point
 * that waits on a second transport, a point nothing proves.
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
    // 0 and 1 are not thresholds, they are switches — and a point that must
    // not decide is removed from the registry, not pinned to a bar.
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

  test("a hot-path point never waits on a second transport", () => {
    // A person is waiting on the turn: a timeout falls back to the path the
    // point replaced, never to another call.
    for (const spec of points) {
      if (spec.path === "hot") {
        expect(spec.fallbackTransport).toBe(false);
        expect(spec.timeoutMs).toBeLessThanOrEqual(2000);
      }
    }
  });

  test("every point names the suites that prove it", () => {
    // Every point decides; the only thing that says a bar is right is the
    // suite that measured it, re-run when the question or the bar changes.
    for (const spec of points) {
      expect(spec.evalGate.suites.length).toBeGreaterThan(0);
    }
  });

  test("the gate never sends an id", () => {
    // A uuid carries nothing a criterion can be about, and every token of
    // noise in the state costs accuracy on the tokens that matter.
    const gate = DECISION_POINTS["workflow.gate"];
    for (const key of gate.state.admit) expect(key).not.toMatch(/Id$/);
    expect(gate.state.admit).toContain("eventType");
  });

  test("the gate admits every fact family's dynamic namespace", () => {
    // A criterion about a team's own field reads `customFields.*`; one the
    // gate never admitted would be judged on a state that lacks it.
    const gate = DECISION_POINTS["workflow.gate"];
    expect(gate.state.admit).toContain("documentSummary");
    expect(gate.state.admit).toContain("customFields.");
    expect(gate.state.admit).toContain("payload.");
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
