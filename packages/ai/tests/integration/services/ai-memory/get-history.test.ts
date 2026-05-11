/**
 * `getMemoryHistory` — per-file timeline behind the Historique modal.
 * Confirms the visibility check (returns null cross-user) and the
 * DESC ordering with the join on `byUser.name`.
 */
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { getMemoryHistory } from "@fretik/shared/services/ai-memory/get-history";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("getMemoryHistory", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("returns DESC-ordered entries with byUser.name joined", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const created = await createMemory({
      rawPath: "/memories/team/timeline.md",
      content: "v1",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await overwriteMemory({
      rawPath: "/memories/team/timeline.md",
      content: "v2",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    const entries = await getMemoryHistory({
      memoryId: created.id,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
    });
    expect(entries).not.toBeNull();
    if (!entries) return;
    expect(entries.length).toBe(2);
    // Most recent first.
    expect(entries[0]?.operation).toBe("overwrite");
    expect(entries[1]?.operation).toBe("create");
    expect(entries[0]?.byUser.name).toMatch(/Tester A/);
  });

  test("returns null when the user cannot see the memory (cross-user private)", async () => {
    const [userA, userB] = fx.userIds;
    const created = await createMemory({
      rawPath: "/memories/user/private.md",
      content: "private",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "human", userId: userA },
    });
    const entries = await getMemoryHistory({
      memoryId: created.id,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userB,
    });
    expect(entries).toBeNull();
  });
});
