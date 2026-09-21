import { describe, expect, test } from "bun:test";
import { appNameOf } from "../../src/services/collections/sync-provenance";

/**
 * What a synced column's app is CALLED, in the one sentence a person reads
 * about where their data comes from.
 *
 * The precedence is the whole test. A connection's display name defaults to the
 * provider's at connect time, so for the ordinary connection both candidates
 * are the same string and nothing here is observable. It becomes observable
 * exactly when a team renamed a connection — which is what a team does when it
 * holds two of the same product, and precisely the moment the old order printed
 * one name for both.
 *
 * No provider is registered in this process, so the manifest arm is absent and
 * the fallbacks are what these assert. The registered-provider arm is covered
 * where it matters — `packages/providers/tests/unit/eval-fixture.test.ts` runs
 * with the registry populated.
 */
describe("appNameOf", () => {
  test("the name the team gave the connection wins", () => {
    expect(appNameOf("front", "Front — Sales")).toBe("Front — Sales");
    expect(appNameOf("front", "Front — Support")).toBe("Front — Support");
  });

  test("two connections of one provider are told apart", () => {
    // The defect this ordering fixes: both sources reported the same app, in
    // the sentence meant to say which one fills which column.
    const first = appNameOf("front", "Front — Sales");
    const second = appNameOf("front", "Front — Support");
    expect(first).not.toBe(second);
  });

  test("an unnamed connection falls back rather than showing nothing", () => {
    // `null` is reachable: a source can outlive the connection row it pointed
    // at, and a blank app name in a provenance line is worse than a key.
    expect(appNameOf("some-provider", null)).toBe("some-provider");
  });
});
