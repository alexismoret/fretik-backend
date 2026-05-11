/**
 * `deleteMemory` — DELETE the parent row, but the audit row survives
 * with `memoryId IS NULL` thanks to the `ON DELETE SET NULL` FK.
 * Tests the reason persistence and the "delete twice" 404 path.
 */
import db from "@fretik/shared/db";
import { aiMemories, aiMemoryHistory } from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { deleteMemory } from "@fretik/shared/services/ai-memory/delete";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("deleteMemory", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("removes the row but preserves the audit history with reason", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const created = await createMemory({
      rawPath: "/memories/team/to-delete.md",
      content: "obsolete",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    await deleteMemory({
      rawPath: "/memories/team/to-delete.md",
      scopeKey,
      actor: { actor: "human", userId: userA },
      reason: "no longer relevant",
    });

    // Parent row gone.
    const remaining = await db
      .select()
      .from(aiMemories)
      .where(eq(aiMemories.id, created.id));
    expect(remaining.length).toBe(0);

    // Audit row(s) still here — `memoryId` set to NULL by cascade.
    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(isNull(aiMemoryHistory.memoryId));
    const deleteEvent = history.find(
      (h) => h.operation === "delete" && h.previousPath === "to-delete.md",
    );
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent?.previousContent).toBe("obsolete");
    expect(deleteEvent?.reason).toBe("no longer relevant");
  });

  test("returns 404 when the path does not exist", async () => {
    const [userA] = fx.userIds;
    let thrown: unknown;
    try {
      await deleteMemory({
        rawPath: "/memories/team/never-existed.md",
        scopeKey: {
          organizationId: fx.organizationId,
          teamId: fx.teamId,
          userId: userA,
        },
        actor: { actor: "human", userId: userA },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      expect(thrown.status).toBe(404);
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_FILE_NOT_FOUND");
    }
  });
});
