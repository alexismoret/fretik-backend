/**
 * `listMemoriesForUi` — settings-list query: merges user+team rows,
 * scopes user rows to the caller, joins `createdBy.name` /
 * `lastModifiedBy.name`. Cross-team isolation tested here too.
 */
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { listMemoriesForUi } from "@fretik/shared/services/ai-memory/list-for-ui";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("listMemoriesForUi", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("returns user-scope rows of the caller + team rows of the team", async () => {
    const [userA, userB] = fx.userIds;
    const scope = (userId: string) => ({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId,
    });
    await createMemory({
      rawPath: "/memories/user/a-only.md",
      content: "private to A",
      scopeKey: scope(userA),
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/user/b-only.md",
      content: "private to B",
      scopeKey: scope(userB),
      actor: { actor: "human", userId: userB },
    });
    await createMemory({
      rawPath: "/memories/team/shared.md",
      content: "team",
      scopeKey: scope(userA),
      actor: { actor: "human", userId: userA },
    });

    const fromA = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 50,
      offset: 0,
    });
    const aPaths = fromA.memories.map((m) => m.path).sort();
    expect(aPaths).toEqual(["a-only.md", "shared.md"]);

    const fromB = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userB,
      limit: 50,
      offset: 0,
    });
    const bPaths = fromB.memories.map((m) => m.path).sort();
    expect(bPaths).toEqual(["b-only.md", "shared.md"]);
    expect(fromB.total).toBe(2);
  });

  test("joins the user name onto createdBy / lastModifiedBy", async () => {
    const [userA] = fx.userIds;
    await createMemory({
      rawPath: "/memories/team/named.md",
      content: "x",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "human", userId: userA },
    });
    const result = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 50,
      offset: 0,
    });
    const named = result.memories.find((r) => r.path === "named.md");
    expect(named?.createdBy.userId).toBe(userA);
    expect(named?.createdBy.name).toMatch(/Tester A/);
    expect(named?.lastModifiedBy.name).toMatch(/Tester A/);
  });

  test("does NOT leak rows of another team", async () => {
    const [userA] = fx.userIds;
    const otherFx = await createMemoryTestFixture();
    await createMemory({
      rawPath: "/memories/team/other-team.md",
      content: "secret",
      scopeKey: {
        organizationId: otherFx.organizationId,
        teamId: otherFx.teamId,
        userId: otherFx.userIds[0],
      },
      actor: { actor: "human", userId: otherFx.userIds[0] },
    });
    const result = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 50,
      offset: 0,
    });
    expect(
      result.memories.find((r) => r.path === "other-team.md"),
    ).toBeUndefined();
    await otherFx.cleanup();
  });

  test("filters by scope='team' and respects limit/offset pagination", async () => {
    const [userA] = fx.userIds;
    const scope = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    // Seed 5 team-scope rows so we can exercise pagination.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- serial for ordering
      await createMemory({
        rawPath: `/memories/team/page-${i.toString()}.md`,
        content: `entry ${i.toString()}`,
        scopeKey: scope,
        actor: { actor: "human", userId: userA },
      });
    }
    const firstPage = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      scope: "team",
      limit: 2,
      offset: 0,
    });
    expect(firstPage.memories.length).toBe(2);
    expect(firstPage.total).toBeGreaterThanOrEqual(5);
    expect(firstPage.memories.every((m) => m.scope === "team")).toBe(true);

    const secondPage = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      scope: "team",
      limit: 2,
      offset: 2,
    });
    expect(secondPage.memories.length).toBe(2);
    expect(secondPage.memories[0]?.id).not.toBe(firstPage.memories[0]?.id);
  });
});
