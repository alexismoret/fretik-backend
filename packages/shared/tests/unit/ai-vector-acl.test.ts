import { describe, expect, test } from "bun:test";
import type { GrantFact } from "../../src/authz/principal";
import type { ResourceNode } from "../../src/authz/rules";
import { aclOfNode } from "../../src/services/ai-vectors/acl";

/**
 * Who the assistant's search may show a resource to (`acl_principals`): the
 * same walk as the rules — owner, grants, then the folder, stopping at the
 * first restricted node, the container last — or null when that is simply
 * the container's, which the rows' team already says.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-00000000000a";
const PROJECT = "00000000-0000-4000-8000-00000000000b";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const FOLDER_OWNER = "00000000-0000-4000-8000-0000000000a2";
const ALICE = "00000000-0000-4000-8000-0000000000a3";
const OTHER_TEAM = "00000000-0000-4000-8000-00000000000c";

const grant = (
  principalType: GrantFact["principalType"],
  principalId: string,
): GrantFact => ({ principalType, principalId, level: "view" });

const node = (overrides: Partial<ResourceNode> = {}): ResourceNode => ({
  type: "document",
  id: "00000000-0000-4000-8000-0000000000d1",
  organizationId: ORG,
  teamId: TEAM,
  projectId: null,
  ownerUserId: OWNER,
  restricted: false,
  grants: [],
  parent: null,
  ...overrides,
});

const folder = (overrides: Partial<ResourceNode> = {}): ResourceNode =>
  node({
    type: "folder",
    id: "00000000-0000-4000-8000-0000000000f1",
    ownerUserId: FOLDER_OWNER,
    ...overrides,
  });

describe("aclOfNode", () => {
  test("an open item nothing is shared from keeps its team's scope", () => {
    expect(aclOfNode(node())).toBeNull();
    expect(aclOfNode(node({ parent: folder() }))).toBeNull();
  });

  test("a restricted item reaches its owner and its grants, never its team", () => {
    expect(aclOfNode(node({ restricted: true }))).toEqual([OWNER]);
    expect(
      aclOfNode(
        node({
          restricted: true,
          grants: [grant("user", ALICE), grant("team", OTHER_TEAM)],
        }),
      ),
    ).toEqual([OWNER, ALICE, OTHER_TEAM].sort());
  });

  test("a restricted item with its owner gone reaches nobody but its grants", () => {
    expect(aclOfNode(node({ restricted: true, ownerUserId: null }))).toEqual(
      [],
    );
  });

  test("an open item shared further reaches its container too", () => {
    expect(aclOfNode(node({ grants: [grant("organization", ORG)] }))).toEqual(
      [OWNER, ORG, TEAM].sort(),
    );
    expect(
      aclOfNode(node({ projectId: PROJECT, grants: [grant("user", ALICE)] })),
    ).toEqual([OWNER, ALICE, PROJECT].sort());
  });

  test("an open document inherits its folder's audience, up to the first restriction", () => {
    const restrictedFolder = folder({
      restricted: true,
      grants: [grant("user", ALICE)],
    });
    expect(aclOfNode(node({ parent: restrictedFolder }))).toEqual(
      [OWNER, FOLDER_OWNER, ALICE].sort(),
    );
  });

  test("a restricted document ignores the folder it sits in", () => {
    const sharedFolder = folder({ grants: [grant("team", OTHER_TEAM)] });
    expect(aclOfNode(node({ restricted: true, parent: sharedFolder }))).toEqual(
      [OWNER],
    );
  });

  test("a folder shared further makes its open documents reach it and the team", () => {
    const sharedFolder = folder({ grants: [grant("team", OTHER_TEAM)] });
    expect(aclOfNode(node({ parent: sharedFolder }))).toEqual(
      [OWNER, FOLDER_OWNER, OTHER_TEAM, TEAM].sort(),
    );
  });
});
