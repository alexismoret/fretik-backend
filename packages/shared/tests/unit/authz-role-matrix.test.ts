import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CAPABILITY_NAMES,
  capabilityPolicy,
} from "../../src/authz/capabilities";
import { buildRoleMatrix } from "../../src/authz/role-matrix";
import type { RoleMatrixRow } from "../../src/schemas/access-api";
import {
  DEFAULT_ORGANIZATION_ACCESS_POLICY,
  type OrganizationAccessPolicy,
  organizationAccessPolicySchema,
} from "../../src/schemas/access-policy";

/**
 * The "Roles and permissions" grid, and the one thing it could get wrong on
 * its own: which setting it says moves a row.
 *
 * Every capability declares the policy setting that moves it
 * (`capabilities.ts`, `policy`), and the grid links each row to that setting.
 * A tag the decision does not read would send an administrator to a switch
 * that changes nothing; a decision that reads a setting it does not declare
 * would change a row with no link to why. So this sweeps every setting
 * through every value it can take, and asserts that the settings which move a
 * capability's row are EXACTLY the one it declares — none, when it declares
 * none.
 */

const POLICY_KEYS = Object.keys(
  DEFAULT_ORGANIZATION_ACCESS_POLICY,
) as (keyof OrganizationAccessPolicy)[];

/** Every value a setting can be set to. */
const valuesOf = (key: keyof OrganizationAccessPolicy): unknown[] => {
  const field = organizationAccessPolicySchema.shape[key];
  if (field instanceof z.ZodEnum) return field.options;
  if (field instanceof z.ZodBoolean) return [true, false];
  // A duration: unlimited, or some number of days.
  return [null, 30];
};

const rowsUnder = (
  policy: OrganizationAccessPolicy,
): Map<string, RoleMatrixRow["standings"]> =>
  new Map(
    buildRoleMatrix(policy).map((row) => [row.capability, row.standings]),
  );

describe("the roles grid", () => {
  const defaults = rowsUnder(DEFAULT_ORGANIZATION_ACCESS_POLICY);

  test("has one row per capability", () => {
    expect([...defaults.keys()]).toEqual([...CAPABILITY_NAMES]);
  });

  test("links each row to exactly the setting that moves it", () => {
    for (const capability of CAPABILITY_NAMES) {
      const moving = POLICY_KEYS.filter((key) =>
        valuesOf(key).some((value) => {
          const moved = rowsUnder({
            ...DEFAULT_ORGANIZATION_ACCESS_POLICY,
            [key]: value,
          });
          return !Bun.deepEquals(
            moved.get(capability),
            defaults.get(capability),
          );
        }),
      );
      const declared = capabilityPolicy(capability);
      expect({ capability, moving }).toEqual({
        capability,
        moving: declared === null ? [] : [declared],
      });
    }
  });

  test("reproduces the product before policies: members create, admins create teams", () => {
    const teamsCreate = defaults.get("teams.create");
    const contentCreate = defaults.get("team.content.create");

    expect(teamsCreate?.admin).toEqual({ allowed: true });
    expect(teamsCreate?.member).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "admin",
    });
    expect(contentCreate?.member).toEqual({ allowed: true });
    expect(contentCreate?.viewer).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "member",
    });
    expect(contentCreate?.guest).toMatchObject({
      allowed: false,
      reason: "GUEST_RESTRICTED",
    });
  });
});
