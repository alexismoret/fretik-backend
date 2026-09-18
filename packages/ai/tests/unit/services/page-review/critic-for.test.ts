import { beforeAll, describe, expect, test } from "bun:test";
import {
  clearResolvedModelCache,
  getProfileForRole,
} from "../../../../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../../../src/lib/model-registry/role-bindings";
import { criticRoleForBuilder } from "../../../../src/services/page-review/evaluate";
import { installBoundFleet } from "../../../lib/live-fleet";

/**
 * A critic never grades its own family. The fallback builder is the critic's
 * own model on purpose (the strongest family-disjoint model in the fleet is
 * the critic), so the pair `page-build-fallback` / `page-review-fallback`
 * exists to keep that invariant on the path where the build already went
 * wrong once.
 */
describe("criticRoleForBuilder", () => {
  beforeAll(() => {
    installBoundFleet();
    clearResolvedModelCache();
  });

  test("no builder named — the parent's review — keeps the page critic", () => {
    expect(criticRoleForBuilder(undefined)).toBe("page-review");
  });

  test("the primary builder is judged by the page critic", () => {
    expect(criticRoleForBuilder(ROLE_BINDINGS["page-build"].profileKey)).toBe(
      "page-review",
    );
  });

  test("the fallback builder is judged by the family-disjoint critic", () => {
    expect(
      criticRoleForBuilder(ROLE_BINDINGS["page-build-fallback"].profileKey),
    ).toBe("page-review-fallback");
  });

  test("both pairs are family-disjoint, and each fallback differs from its primary", () => {
    const family = (role: Parameters<typeof getProfileForRole>[0]) =>
      getProfileForRole(role).family;
    expect(family("page-build")).not.toBe(family("page-review"));
    expect(family("page-build-fallback")).not.toBe(
      family("page-review-fallback"),
    );
    expect(family("page-build")).not.toBe(family("page-build-fallback"));
    expect(family("page-review")).not.toBe(family("page-review-fallback"));
  });
});
