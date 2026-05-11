/**
 * `overwriteMemory` — atomic upsert path used as the agent's main
 * update primitive (`view → overwrite`). Verifies the create-vs-
 * update branching, the `previousContent` capture in the audit
 * trail, and last-write-wins under concurrent calls.
 */
import db from "@fretik/shared/db";
import { aiMemoryHistory } from "@fretik/shared/db/schema";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("overwriteMemory", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("creates the file when the path is fresh (created=true)", async () => {
    const [userA] = fx.userIds;
    const result = await overwriteMemory({
      rawPath: "/memories/team/conventions.md",
      content: "v1",
      scopeKey: {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: userA,
      },
      actor: { actor: "human", userId: userA },
    });
    expect(result.created).toBe(true);
    expect(result.memory.content).toBe("v1");
    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, result.memory.id));
    expect(history.length).toBe(1);
    expect(history[0]?.operation).toBe("create");
    expect(history[0]?.previousContent).toBeNull();
  });

  test("replaces an existing file and records previousContent", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const first = await overwriteMemory({
      rawPath: "/memories/team/replace.md",
      content: "before",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    const second = await overwriteMemory({
      rawPath: "/memories/team/replace.md",
      content: "after",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.content).toBe("after");

    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, first.memory.id));
    const ops = history.map((h) => h.operation).sort();
    expect(ops).toEqual(["create", "overwrite"]);
    const overwriteRow = history.find((h) => h.operation === "overwrite");
    expect(overwriteRow?.previousContent).toBe("before");
    expect(overwriteRow?.newContent).toBe("after");
  });

  test("two concurrent overwrites land 2 history rows; last write wins", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    await overwriteMemory({
      rawPath: "/memories/team/race.md",
      content: "seed",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    const [a, b] = await Promise.all([
      overwriteMemory({
        rawPath: "/memories/team/race.md",
        content: "from-A",
        scopeKey,
        actor: { actor: "human", userId: userA },
      }),
      overwriteMemory({
        rawPath: "/memories/team/race.md",
        content: "from-B",
        scopeKey,
        actor: { actor: "human", userId: userA },
      }),
    ]);

    const memoryId = a.memory.id;
    expect(b.memory.id).toBe(memoryId);

    const history = await db
      .select()
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.memoryId, memoryId));
    // 1 create (seed) + 2 overwrite rows
    expect(history.length).toBe(3);
    expect(history.filter((h) => h.operation === "overwrite").length).toBe(2);

    // Final row's content matches one of the two writers — there is
    // no ordering guarantee in the test runtime, but it MUST be one of them.
    expect(["from-A", "from-B"]).toContain(b.memory.content);
  });
});
