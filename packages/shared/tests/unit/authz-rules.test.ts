import { describe, expect, test } from "bun:test";
import type { UserPrincipal } from "../../src/authz/principal";
import { computeLevel, type ResourceNode } from "../../src/authz/rules";
import type { AccessLevel, TeamRole } from "../../src/schemas/access";

/**
 * The access rules as a table — `computeLevel` is pure, so every rule of the
 * model can be stated as one fact and checked without a database.
 *
 * Each case changes ONE thing against its neighbour (a restriction, a role, a
 * grant), so a rule that silently stops applying fails here with the fact it
 * broke, not somewhere downstream as a list that shows one row too many.
 */

const ORG = "org-1";
const TEAM = "team-a";
const OTHER_TEAM = "team-b";
const ME = "user-me";
const SOMEONE = "user-someone";
const PROJECT = "project-1";

const person = (overrides: {
  teams?: Record<string, TeamRole>;
  contentLevels?: Record<string, AccessLevel>;
  projects?: Record<string, AccessLevel>;
  isGuest?: boolean;
  isOrgAdmin?: boolean;
}): UserPrincipal => {
  const teams = overrides.teams ?? {};
  const contentLevels =
    overrides.contentLevels ??
    Object.fromEntries(
      Object.entries(teams).map(([teamId, role]) => [
        teamId,
        role === "viewer" ? "view" : "full",
      ]),
    );
  return {
    kind: "user",
    userId: ME,
    organizationId: ORG,
    orgRole: overrides.isGuest
      ? "guest"
      : overrides.isOrgAdmin
        ? "admin"
        : "member",
    isOrgAdmin: overrides.isOrgAdmin ?? false,
    isGuest: overrides.isGuest ?? false,
    teamRoles: new Map(Object.entries(teams)),
    teamContentLevels: new Map(Object.entries(contentLevels)),
    projectLevels: new Map(Object.entries(overrides.projects ?? {})),
  };
};

const node = (overrides: Partial<ResourceNode> = {}): ResourceNode => ({
  type: "document",
  id: "node-1",
  organizationId: ORG,
  teamId: TEAM,
  projectId: null,
  ownerUserId: SOMEONE,
  restricted: false,
  grants: [],
  parent: null,
  ...overrides,
});

const member = person({ teams: { [TEAM]: "member" } });

describe("ownership and the organization boundary", () => {
  test("the owner has full access, restricted or not", () => {
    const mine = node({ ownerUserId: ME, restricted: true });
    expect(computeLevel(person({}), mine)).toBe("full");
  });

  test("nothing crosses organizations, not even ownership", () => {
    const elsewhere = node({ ownerUserId: ME, organizationId: "org-2" });
    expect(computeLevel(person({}), elsewhere)).toBeNull();
  });
});

describe("the team container", () => {
  test("a team member gets what the team gives on its content", () => {
    expect(computeLevel(member, node())).toBe("full");
  });

  test("the team's policy can lower what members get", () => {
    const editOnly = person({
      teams: { [TEAM]: "member" },
      contentLevels: { [TEAM]: "edit" },
    });
    expect(computeLevel(editOnly, node())).toBe("edit");
  });

  test("a viewer reads", () => {
    const viewer = person({ teams: { [TEAM]: "viewer" } });
    expect(computeLevel(viewer, node())).toBe("view");
  });

  test("another team's content is invisible without a grant", () => {
    const outsider = person({ teams: { [OTHER_TEAM]: "member" } });
    expect(computeLevel(outsider, node())).toBeNull();
  });

  test("an organization admin reads nothing by role alone", () => {
    const admin = person({ isOrgAdmin: true });
    expect(computeLevel(admin, node())).toBeNull();
  });

  test("restricting takes the team's access away, and only that", () => {
    expect(computeLevel(member, node({ restricted: true }))).toBeNull();
  });
});

describe("grants", () => {
  test("a grant to the person reaches a restricted resource", () => {
    const shared = node({
      restricted: true,
      grants: [{ principalType: "user", principalId: ME, level: "edit" }],
    });
    expect(computeLevel(person({}), shared)).toBe("edit");
  });

  test("the highest path wins, there is no deny", () => {
    const shared = node({
      grants: [{ principalType: "user", principalId: ME, level: "view" }],
    });
    expect(computeLevel(member, shared)).toBe("full");
  });

  test("a grant to a team gives its members the level", () => {
    const shared = node({
      restricted: true,
      grants: [
        { principalType: "team", principalId: OTHER_TEAM, level: "edit" },
      ],
    });
    const other = person({ teams: { [OTHER_TEAM]: "member" } });
    expect(computeLevel(other, shared)).toBe("edit");
  });

  test("…but a viewer of that team only reads", () => {
    const shared = node({
      restricted: true,
      grants: [
        { principalType: "team", principalId: OTHER_TEAM, level: "edit" },
      ],
    });
    const viewer = person({ teams: { [OTHER_TEAM]: "viewer" } });
    expect(computeLevel(viewer, shared)).toBe("view");
  });

  test("a grant to the organization reaches every member", () => {
    const shared = node({
      restricted: true,
      grants: [
        { principalType: "organization", principalId: ORG, level: "view" },
      ],
    });
    expect(computeLevel(person({}), shared)).toBe("view");
  });

  test("…but never a guest", () => {
    const shared = node({
      restricted: true,
      grants: [
        { principalType: "organization", principalId: ORG, level: "view" },
      ],
    });
    expect(computeLevel(person({ isGuest: true }), shared)).toBeNull();
  });

  test("a grant to a project reaches its members, capped for readers", () => {
    const shared = node({
      restricted: true,
      grants: [
        { principalType: "project", principalId: PROJECT, level: "edit" },
      ],
    });
    expect(
      computeLevel(person({ projects: { [PROJECT]: "edit" } }), shared),
    ).toBe("edit");
    expect(
      computeLevel(person({ projects: { [PROJECT]: "use" } }), shared),
    ).toBe("view");
  });
});

describe("folders", () => {
  const folder = (overrides: Partial<ResourceNode> = {}): ResourceNode =>
    node({ type: "folder", id: "folder-1", ...overrides });

  test("a document inherits its folder's grants", () => {
    const sharedFolder = folder({
      restricted: true,
      grants: [{ principalType: "user", principalId: ME, level: "edit" }],
    });
    const inside = node({ parent: sharedFolder });
    expect(computeLevel(person({}), inside)).toBe("edit");
  });

  test("a restricted folder hides what it holds from the team", () => {
    const hidden = folder({ restricted: true });
    expect(computeLevel(member, node({ parent: hidden }))).toBeNull();
    expect(computeLevel(member, node({ parent: folder() }))).toBe("full");
  });

  test("a grant above a restricted folder does not reach inside it", () => {
    const top = folder({
      id: "folder-top",
      grants: [{ principalType: "user", principalId: ME, level: "full" }],
    });
    const fenced = folder({
      id: "folder-fenced",
      restricted: true,
      parent: top,
    });
    expect(computeLevel(person({}), node({ parent: top }))).toBe("full");
    expect(computeLevel(person({}), node({ parent: fenced }))).toBeNull();
  });

  test("a restricted document in an open folder is only its own", () => {
    const inside = node({ restricted: true, parent: folder() });
    expect(computeLevel(member, inside)).toBeNull();
  });
});

describe("projects", () => {
  test("content open to its project gives the project's members its level", () => {
    const inProject = node({ projectId: PROJECT });
    expect(
      computeLevel(person({ projects: { [PROJECT]: "edit" } }), inProject),
    ).toBe("edit");
  });

  test("taking part in a project reads the others' work, never changes it", () => {
    const inProject = node({ projectId: PROJECT });
    expect(
      computeLevel(person({ projects: { [PROJECT]: "use" } }), inProject),
    ).toBe("view");
  });

  test("project content does not fall back to the team", () => {
    const inProject = node({ projectId: PROJECT });
    expect(computeLevel(member, inProject)).toBeNull();
  });

  test("an open project gives its team members `edit`, its leads `full`", () => {
    const project = node({ type: "project", id: PROJECT, projectId: null });
    expect(computeLevel(member, project)).toBe("edit");
    expect(computeLevel(person({ teams: { [TEAM]: "lead" } }), project)).toBe(
      "full",
    );
    expect(computeLevel(person({ teams: { [TEAM]: "viewer" } }), project)).toBe(
      "view",
    );
  });

  test("a restricted project is its members' alone", () => {
    const project = node({ type: "project", id: PROJECT, restricted: true });
    expect(computeLevel(member, project)).toBeNull();
  });
});

describe("type ceilings", () => {
  test("an open conversation can be read by the team, not joined by inheriting", () => {
    const conversation = node({ type: "conversation", restricted: false });
    expect(computeLevel(member, conversation)).toBe("view");
    expect(
      computeLevel(member, { ...conversation, restricted: true }),
    ).toBeNull();
  });

  test("a seat in a conversation is taking part", () => {
    const conversation = node({
      type: "conversation",
      restricted: true,
      grants: [{ principalType: "user", principalId: ME, level: "use" }],
    });
    expect(computeLevel(person({}), conversation)).toBe("use");
  });

  test("a workflow running with its owner's access can only be shown to others", () => {
    const privateRun = node({
      type: "workflow",
      restricted: true,
      grants: [{ principalType: "user", principalId: ME, level: "full" }],
    });
    expect(computeLevel(person({}), privateRun)).toBe("view");
    expect(computeLevel(person({}), { ...privateRun, ownerUserId: ME })).toBe(
      "full",
    );
  });

  test("an open workflow runs as the team's agent, so grants apply in full", () => {
    const teamRun = node({
      type: "workflow",
      restricted: false,
      grants: [{ principalType: "user", principalId: ME, level: "edit" }],
    });
    expect(computeLevel(person({}), teamRun)).toBe("edit");
  });
});
