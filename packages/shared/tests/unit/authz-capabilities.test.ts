import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import {
  type Capability,
  decideCapability,
} from "../../src/authz/capabilities";
import { systemPrincipal, type UserPrincipal } from "../../src/authz/principal";
import type { OrganizationRole, TeamRole } from "../../src/schemas/access";
import {
  DEFAULT_ORGANIZATION_ACCESS_POLICY,
  type OrganizationAccessPolicy,
} from "../../src/schemas/access-policy";

/**
 * Capabilities take two keys — the role and the policy — and the refusal says
 * which one was missing, because the answer differs: a missing role is a
 * promotion, a policy is an administrator's setting.
 *
 * The defaults must reproduce what the product allowed before the engine: the
 * first block pins that, so turning the engine on changes nothing for anyone.
 */

const TEAM = "team-a";

const person = (
  orgRole: OrganizationRole,
  teamRole: TeamRole | null = "member",
): UserPrincipal => ({
  kind: "user",
  userId: "me",
  organizationId: "org",
  orgRole,
  isOrgAdmin: orgRole === "owner" || orgRole === "admin",
  isGuest: orgRole === "guest",
  teamRoles: new Map(teamRole === null ? [] : [[TEAM, teamRole]]),
  teamContentLevels: new Map(),
  projectLevels: new Map(),
});

const decide = (
  principal: UserPrincipal,
  capability: Capability,
  policy: Partial<OrganizationAccessPolicy> = {},
) =>
  decideCapability({
    principal,
    capability,
    policy: { ...DEFAULT_ORGANIZATION_ACCESS_POLICY, ...policy },
    teamId: TEAM,
  });

describe("the defaults reproduce what members could do before", () => {
  const member = person("member");

  test.each<Capability>([
    "team.context.edit",
    "team.connections.manage",
    "team.workflows.autonomous",
    "team.content.create",
    "projects.create",
    "share.public_link",
    "share.cross_team",
    "share.organization",
    "directory.read",
  ])("a member may %s", (capability) => {
    expect(decide(member, capability)).toEqual({ allowed: true });
  });

  test.each<Capability>([
    "team.settings.manage",
    "team.members.manage",
    "members.manage",
    "members.invite",
    "teams.create",
    "policies.manage",
  ])("a member may not %s", (capability) => {
    expect(decide(member, capability).allowed).toBe(false);
  });
});

describe("roles", () => {
  test("a team lead manages the team without being an organization admin", () => {
    expect(decide(person("member", "lead"), "team.members.manage")).toEqual({
      allowed: true,
    });
    expect(decide(person("member", "member"), "team.members.manage")).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "lead",
    });
  });

  test("an organization admin leads every team, member of it or not", () => {
    expect(decide(person("admin", null), "team.settings.manage")).toEqual({
      allowed: true,
    });
  });

  test("a viewer reads: no content, no team context", () => {
    const viewer = person("member", "viewer");
    expect(decide(viewer, "team.content.create").allowed).toBe(false);
    expect(decide(viewer, "team.context.edit")).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "member",
    });
  });

  test("a guest is refused as a guest, whatever the policy", () => {
    const guest = person("guest", null);
    expect(
      decide(guest, "share.cross_team", { crossTeamSharing: true }),
    ).toEqual({
      allowed: false,
      reason: "GUEST_RESTRICTED",
      requiredRole: null,
    });
  });

  test("a system caller has every capability", () => {
    expect(
      decideCapability({
        principal: systemPrincipal("test"),
        capability: "policies.manage",
        policy: DEFAULT_ORGANIZATION_ACCESS_POLICY,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("policies", () => {
  test("narrowing a capability to leads refuses members as a POLICY, not a role", () => {
    expect(
      decide(person("member"), "team.connections.manage", {
        teamConnections: "leads",
      }),
    ).toEqual({
      allowed: false,
      reason: "POLICY_DISABLED",
      requiredRole: "lead",
    });
    expect(
      decide(person("member", "lead"), "team.connections.manage", {
        teamConnections: "leads",
      }),
    ).toEqual({ allowed: true });
  });

  test("a switched-off capability is off for everyone, admins included", () => {
    for (const principal of [person("member"), person("owner")]) {
      expect(
        decide(principal, "share.public_link", { publicLinks: "nobody" }),
      ).toEqual({
        allowed: false,
        reason: "POLICY_DISABLED",
        requiredRole: null,
      });
    }
  });

  test("letting members create teams reaches members only", () => {
    expect(
      decide(person("member"), "teams.create", { teamCreation: "members" }),
    ).toEqual({ allowed: true });
    expect(
      decide(person("guest", null), "teams.create", {
        teamCreation: "members",
      }).allowed,
    ).toBe(false);
  });

  test("letting leads invite reaches leads, and members are told who can", () => {
    const policy = { memberInvitations: "leads" } as const;
    expect(decide(person("member", "lead"), "members.invite", policy)).toEqual({
      allowed: true,
    });
    expect(decide(person("member"), "members.invite", policy)).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "lead",
    });
  });
});
