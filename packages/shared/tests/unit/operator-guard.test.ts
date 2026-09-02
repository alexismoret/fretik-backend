import { describe, expect, test } from "bun:test";
import { decideOperatorTarget } from "../../src/lib/operator-guard";

/**
 * The rule that decides whether a command may touch production.
 *
 * Written against the incident it exists to prevent: a `models:admin` run from
 * a laptop, through an SSH tunnel, against production — an invocation in which
 * the URL (`127.0.0.1:5434`), the hostname and `NODE_ENV` all said "local".
 * Every case below is a variation on that shape.
 */

const NOTHING = {};
const CONTAINER = { runtime: "container" };
const BREAK_GLASS = { allowLaptopProd: "1" };

describe("decideOperatorTarget", () => {
  test("a disposable database needs no flag and no container", () => {
    // Both ends and both separators: the CI database is `test-fretik`, the
    // convention elsewhere is `fretik_test`, and a rule that only knew one of
    // them would send an honest operator looking for the break-glass switch.
    for (const name of [
      "fretik_dev",
      "fretik_test",
      "fretik_ci",
      "test-fretik",
      "ci-fretik",
      "dev_fretik",
    ]) {
      expect(decideOperatorTarget(name, [], NOTHING)).toEqual({
        verdict: "allow",
        target: "dev",
        breakGlass: false,
      });
    }
  });

  test("any other name is production, whatever the URL looked like", () => {
    expect(decideOperatorTarget("fretik", [], NOTHING)).toEqual({
      verdict: "refuse",
      target: "prod",
      reason: "unflagged",
    });
  });

  test("a name that merely CONTAINS a safe marker is not disposable", () => {
    // The marker has to sit at one END of the name. `fretik_dev_restore` is a
    // restored copy of production, and `latest-fretik` merely ends in the
    // letters of a word — reading either loosely is how a "safe" pattern stops
    // being one.
    for (const name of ["fretik_dev_restore", "latest-fretik", "protest"]) {
      expect(decideOperatorTarget(name, [], NOTHING)).toEqual({
        verdict: "refuse",
        target: "prod",
        reason: "unflagged",
      });
    }
  });

  test("the flag alone does not authorise production — this IS the incident", () => {
    expect(decideOperatorTarget("fretik", ["--target=prod"], NOTHING)).toEqual({
      verdict: "refuse",
      target: "prod",
      reason: "not-in-container",
    });
  });

  test("the container alone does not either: production is always deliberate", () => {
    expect(decideOperatorTarget("fretik", [], CONTAINER)).toEqual({
      verdict: "refuse",
      target: "prod",
      reason: "unflagged",
    });
  });

  test("flag plus container is the normal production path", () => {
    expect(
      decideOperatorTarget("fretik", ["--target=prod"], CONTAINER),
    ).toEqual({ verdict: "allow", target: "prod", breakGlass: false });
  });

  test("break-glass allows a laptop, and says so", () => {
    expect(
      decideOperatorTarget("fretik", ["--target=prod"], BREAK_GLASS),
    ).toEqual({ verdict: "allow", target: "prod", breakGlass: true });
  });

  test("break-glass without the flag is still refused", () => {
    expect(decideOperatorTarget("fretik", [], BREAK_GLASS)).toEqual({
      verdict: "refuse",
      target: "prod",
      reason: "unflagged",
    });
  });
});
