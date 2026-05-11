/**
 * `createMemory` — agent + human writes, byte-cap enforcement, and
 * the conflict mapping when a path already exists. These also act
 * as the smoke test for the audit trail (history rows + actor / by-
 * conversation attribution) that every other write service shares.
 */
import db from "@fretik/shared/db";
import { aiMemoryHistory } from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("createMemory", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("creates a user-scope memory with audit row (human actor)", async () => {
    const [userA] = fx.userIds;
    const created = await createMemory({
      rawPath: "/memories/user/preferences.md",
      content: "Prefer kilograms over pounds.",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "human", userId: userA },
    });

    expect(created.scope).toBe("user");
    expect(created.userId).toBe(userA);
    expect(created.path).toBe("preferences.md");
    expect(created.createdByActor).toBe("human");
    expect(created.createdByConversationId).toBeNull();

    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, created.id));
    expect(history.length).toBe(1);
    expect(history[0]?.operation).toBe("create");
    expect(history[0]?.byActor).toBe("human");
    expect(history[0]?.byConversationId).toBeNull();
  });

  test("creates a team-scope memory with conversation-tagged audit (agent actor)", async () => {
    const [userA] = fx.userIds;
    const conversationId = await fx.createConversation({ userId: userA });

    const created = await createMemory({
      rawPath: "/memories/team/carriers/dhl.md",
      content: "## DHL\nPrimary carrier on MRS→ANR.",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "agent", userId: userA, conversationId },
    });

    expect(created.scope).toBe("team");
    expect(created.userId).toBeNull();
    expect(created.createdByActor).toBe("agent");
    expect(created.createdByConversationId).toBe(conversationId);

    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, created.id));
    expect(history[0]?.byConversationId).toBe(conversationId);
    expect(history[0]?.byActor).toBe("agent");
  });

  test("rejects a duplicate path with MEMORY_FILE_EXISTS (409)", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    await createMemory({
      rawPath: "/memories/user/dup.md",
      content: "first",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    let thrown: unknown;
    try {
      await createMemory({
        rawPath: "/memories/user/dup.md",
        content: "second",
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
      expect(body.code).toBe("MEMORY_FILE_EXISTS");
    }
  });

  test("rejects content above the 50KB cap with MEMORY_TOO_LARGE (400)", async () => {
    const [userA] = fx.userIds;
    const huge = "a".repeat(50 * 1024 + 1);

    let thrown: unknown;
    try {
      await createMemory({
        rawPath: "/memories/user/too-big.md",
        content: huge,
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
      expect(thrown.status).toBe(400);
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_TOO_LARGE");
    }
  });

  test("isolates user-scope rows across users in the same team", async () => {
    const [userA, userB] = fx.userIds;
    await createMemory({
      rawPath: "/memories/user/iso.md",
      content: "owned by A",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "human", userId: userA },
    });

    // userB can write the same relative path because the unique index
    // partial on `scope='user'` keys on (teamId, userId, path).
    const otherUserCreated = await createMemory({
      rawPath: "/memories/user/iso.md",
      content: "owned by B",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userB,
      },
      actor: { actor: "human", userId: userB },
    });
    expect(otherUserCreated.userId).toBe(userB);
  });
});
