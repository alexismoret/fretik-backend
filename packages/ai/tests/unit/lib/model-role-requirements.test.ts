import {
  FLEET_REQUIREMENTS,
  requirementsFor,
  ROLE_REQUIREMENTS,
} from "@fretik/shared/model-registry/requirements";
import { describe, expect, test } from "bun:test";
import { MAX_TOKENS_BUDGET_BY_LEVEL } from "../../../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import type { ModelRole } from "../../../src/lib/model-registry/types";

/**
 * The seam between the two packages that own half this decision each.
 *
 * `requirements.ts` lives in `shared` because the nightly sync runs there and
 * must not drag the profile layer into itself; the roles it is keyed on live
 * here. Nothing in the type system connects them — `bound_roles` is a text
 * array — so these tests are the connection. They are what stops a new role
 * from silently inheriting only the fleet baseline, and what stops the reasoning
 * ladder from being raised without the floors that are computed from it moving
 * too.
 */
describe("role requirements", () => {
  test("every role decides what it needs, or is deliberately absent", () => {
    const roles = Object.keys(ROLE_BINDINGS);
    // A role may legitimately have no requirements — `cheap-tasks` asks for a
    // 256-token title. What must not happen is a role being FORGOTTEN, so the
    // check is that somebody looked: either the table names it, or it is on
    // this list of roles the fleet baseline is known to cover.
    const unconstrained: ModelRole[] = ["cheap-tasks", "tool-repair"];
    const deliberatelyUnconstrained = new Set<string>(unconstrained);
    const undecided = roles.filter(
      (role) =>
        ROLE_REQUIREMENTS[role] === undefined &&
        !deliberatelyUnconstrained.has(role),
    );
    expect(undecided).toEqual([]);
  });

  // The floors are computed as "the role's output budget plus the top reasoning
  // rung", because reasoning tokens are charged against the output cap — the
  // failure `role-bindings.ts` records as "an 8K/32K cap was consumed by
  // mandatory thinking -> `length` cutoff". If the ladder's top rung moves and
  // the floors do not, that failure comes back on the roles that think hardest.
  test("the agent-loop floor still covers the top reasoning rung", () => {
    const top = MAX_TOKENS_BUDGET_BY_LEVEL.max;
    for (const role of ["chat", "workflow", "page-build"]) {
      const floor = ROLE_REQUIREMENTS[role]?.minMaxOutput;
      expect(floor).toBeDefined();
      expect(floor).toBeGreaterThanOrEqual(top);
    }
  });

  // `wrapCache` says "this loop resends a long stable prefix, so inject cache
  // breakpoints". `requireCache` says "so do not route it to a host that cannot
  // serve a cache read". They are two halves of one judgement, and a role that
  // carries the first without the second is wrapping a prefix nothing will
  // store.
  test("every cache-wrapped role demands a host that can cache", () => {
    const wrapped = Object.values(ROLE_BINDINGS)
      .filter((binding) => binding.wrapCache)
      .map((binding) => binding.role);
    const missing = wrapped.filter(
      (role) => ROLE_REQUIREMENTS[role]?.requireCache !== true,
    );
    expect(missing).toEqual([]);
  });

  test("a row bound to nothing still clears the fleet baseline", () => {
    expect(requirementsFor([])).toEqual(FLEET_REQUIREMENTS);
  });

  test("bound roles combine by taking the strictest floor", () => {
    // One pool serves every role on the row, so the chat floor is the one that
    // has to hold: the memory writes would survive a weaker host, the chat
    // turns are what break.
    const both = requirementsFor(["memory-extract", "chat"]);
    expect(both.minMaxOutput).toBe(ROLE_REQUIREMENTS.chat?.minMaxOutput);
    expect(both.requireCache).toBe(true);
  });

  test("an override REPLACES the derived floor, in both directions", () => {
    const relaxed = requirementsFor(["chat"], { minMaxOutput: 8_000 });
    expect(relaxed.minMaxOutput).toBe(8_000);
    const inherited = requirementsFor(["chat"], { minMaxOutput: null });
    expect(inherited.minMaxOutput).toBe(ROLE_REQUIREMENTS.chat?.minMaxOutput);
    // The switch is the case where "off" and "inherit" are genuinely different
    // answers, and the column stores three states so they stay different.
    expect(
      requirementsFor(["chat"], { requireCache: false }).requireCache,
    ).toBe(undefined);
    expect(requirementsFor(["chat"], { requireCache: null }).requireCache).toBe(
      true,
    );
  });
});
