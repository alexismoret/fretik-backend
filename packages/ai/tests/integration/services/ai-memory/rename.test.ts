/**
 * `renameMemory` — intra-namespace move, cross-namespace refusal,
 * destination-exists conflict, audit row with `previousPath/newPath`.
 */
import db from "@fretik/shared/db";
import { aiMemoryHistory } from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { renameMemory } from "@fretik/shared/services/ai-memory/rename";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("renameMemory", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("renames inside the same namespace and writes a rename audit row", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const created = await createMemory({
      rawPath: "/memories/team/carriers/dhl",
      content: "DHL",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    const renamed = await renameMemory({
      oldRawPath: "/memories/team/carriers/dhl",
      newRawPath: "/memories/team/carriers/dhl.md",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    expect(renamed.id).toBe(created.id);
    expect(renamed.path).toBe("carriers/dhl.md");

    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, created.id));
    const renameRow = history.find((h) => h.operation === "rename");
    expect(renameRow?.previousPath).toBe("carriers/dhl");
    expect(renameRow?.newPath).toBe("carriers/dhl.md");
  });

  test("rejects a cross-namespace rename (user → team)", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    await createMemory({
      rawPath: "/memories/user/source.md",
      content: "x",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    let thrown: unknown;
    try {
      await renameMemory({
        oldRawPath: "/memories/user/source.md",
        newRawPath: "/memories/team/source.md",
        scopeKey,
        actor: { actor: "human", userId: userA },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      expect(thrown.status).toBe(400);
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_INVALID_PATH");
    }
  });

  test("rejects rename when the destination already exists", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    await createMemory({
      rawPath: "/memories/team/a.md",
      content: "a",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/b.md",
      content: "b",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    let thrown: unknown;
    try {
      await renameMemory({
        oldRawPath: "/memories/team/a.md",
        newRawPath: "/memories/team/b.md",
        scopeKey,
        actor: { actor: "human", userId: userA },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      expect(thrown.status).toBe(409);
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_RENAME_DEST_EXISTS");
    }
  });
});
