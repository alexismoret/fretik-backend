import { describe, expect, test } from "bun:test";
import {
  GUEST_LEVEL_CEILING,
  guestAccessExpiry,
  guestCeilingFor,
} from "../../src/authz/guests";
import type { ResourceNode } from "../../src/authz/rules";
import { DEFAULT_ORGANIZATION_ACCESS_POLICY } from "../../src/schemas/access-policy";

/**
 * What a guest may be given (`authz/guests.ts`) — pure, so stated as facts:
 * never full access to what is not theirs, a chat read unless they take part
 * where it lives, and an access period only when the organization sets one.
 */

const node = (overrides: Partial<ResourceNode>): ResourceNode => ({
  type: "document",
  id: "node-1",
  organizationId: "org-1",
  teamId: "team-1",
  projectId: null,
  ownerUserId: "owner-1",
  restricted: false,
  grants: [],
  parent: null,
  ...overrides,
});

describe("a guest's ceiling", () => {
  test("is never full access", () => {
    expect(GUEST_LEVEL_CEILING).toBe("edit");
    expect(guestCeilingFor(node({ type: "document" }))).toBe("edit");
    expect(guestCeilingFor(node({ type: "project" }))).toBe("edit");
  });

  test("is reading a chat, unless they take part in the chat's project", () => {
    const teamChat = node({ type: "conversation" });
    expect(guestCeilingFor(teamChat)).toBe("view");
    const projectChat = node({ type: "conversation", projectId: "project-1" });
    expect(guestCeilingFor(projectChat)).toBe("view");
    expect(guestCeilingFor(projectChat, true)).toBe("edit");
  });

  test("is reading a restricted workflow, which runs as its owner", () => {
    expect(guestCeilingFor(node({ type: "workflow", restricted: true }))).toBe(
      "view",
    );
  });
});

describe("a guest's access period", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  test("lasts until removed by default", () => {
    expect(guestAccessExpiry(DEFAULT_ORGANIZATION_ACCESS_POLICY, now)).toBe(
      null,
    );
  });

  test("ends the number of days the organization sets, from today", () => {
    expect(
      guestAccessExpiry(
        { ...DEFAULT_ORGANIZATION_ACCESS_POLICY, guestAccessDays: 30 },
        now,
      ),
    ).toEqual(new Date("2026-10-24T12:00:00Z"));
  });
});
