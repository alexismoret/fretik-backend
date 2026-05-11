/**
 * Full-pipeline integration tests for memory vectorisation (S2).
 *
 * These tests hit the real DB AND real OpenRouter (cheap model for
 * contextual enrichment + Qwen3-Embedding-8B for embeddings). They
 * are slow (LLM round-trips) and require:
 *   - Postgres reachable via DATABASE_URL
 *   - OPENROUTER_API_KEY set
 *   - Redis reachable via REDIS_URL (semaphore for cheap-model calls)
 *
 * Skip pattern: `bun test --test-name-pattern='memory vectorize'` to
 * run these in isolation.
 */
import db from "@fretik/shared/db";
import {
  aiMemories,
  aiVectors,
  type MemoryVectorMetadata,
} from "@fretik/shared/db/schema";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { vectorizeSource } from "../../../../src/services/vectorize";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

const buildMetadata = (
  scope: "user" | "team",
  path: string,
  content: string,
): MemoryVectorMetadata => ({
  scope,
  path,
  size_bytes: Buffer.byteLength(content, "utf8"),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe("memory vectorize (full pipeline)", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("team-scope memory: rows inserted with user_id NULL and [TEAM_MEMORY] prefix", async () => {
    const [userA] = fx.userIds;
    const path = "carriers/dhl.md";
    const content =
      "## DHL\n\nPrimary carrier on MRS→ANR.\n\nContact: ops@dhl.fr\n\nSLA: 48h door-to-door.";

    // Insert the memory directly (bypassing createMemory's HTTP hook —
    // this test exercises vectorizeSource end-to-end without depending
    // on a running AI service).
    const [memory] = await db
      .insert(aiMemories)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        scope: "team",
        userId: null,
        path,
        content,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        createdByUserId: userA,
        createdByActor: "human",
        lastModifiedByUserId: userA,
        lastModifiedByActor: "human",
      })
      .returning();
    if (!memory) throw new Error("failed to insert memory");

    const result = await vectorizeSource({
      sourceType: "memories",
      sourceId: memory.id,
      content,
      metadata: buildMetadata("team", path, content),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });

    expect(result.rowsInserted).toBeGreaterThan(0);
    expect(result.metadataOnly).toBe(false);

    const rows = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          eq(aiVectors.sourceId, memory.id),
        ),
      );

    expect(rows.length).toBe(result.rowsInserted);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.teamId).toBe(fx.teamId);
      expect(row.contextualPrefix).toContain("[TEAM_MEMORY]");
      expect(row.contextualPrefix).toContain(`path:${path}`);
    }
  }, 120_000);

  test("user-scope memory: rows inserted with user_id set and [USER_MEMORY] prefix", async () => {
    const [userA] = fx.userIds;
    const path = "preferences.md";
    const content = "Prefer kilograms over pounds. UI in French.";

    const [memory] = await db
      .insert(aiMemories)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        scope: "user",
        userId: userA,
        path,
        content,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        createdByUserId: userA,
        createdByActor: "human",
        lastModifiedByUserId: userA,
        lastModifiedByActor: "human",
      })
      .returning();
    if (!memory) throw new Error("failed to insert memory");

    const result = await vectorizeSource({
      sourceType: "memories",
      sourceId: memory.id,
      content,
      metadata: buildMetadata("user", path, content),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
    });

    expect(result.rowsInserted).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          eq(aiVectors.sourceId, memory.id),
        ),
      );

    expect(rows.length).toBe(result.rowsInserted);
    for (const row of rows) {
      expect(row.userId).toBe(userA);
      expect(row.teamId).toBe(fx.teamId);
      expect(row.contextualPrefix).toContain("[USER_MEMORY]");
      expect(row.contextualPrefix).toContain(`path:${path}`);
    }
  }, 120_000);

  test("re-vectorising the same memory clears stale rows (idempotent upsert)", async () => {
    const [userA] = fx.userIds;
    const path = "idempotent.md";
    const initial = "Initial content. Short and to the point.";

    const [memory] = await db
      .insert(aiMemories)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        scope: "team",
        userId: null,
        path,
        content: initial,
        sizeBytes: Buffer.byteLength(initial, "utf8"),
        createdByUserId: userA,
        createdByActor: "human",
        lastModifiedByUserId: userA,
        lastModifiedByActor: "human",
      })
      .returning();
    if (!memory) throw new Error("failed to insert memory");

    await vectorizeSource({
      sourceType: "memories",
      sourceId: memory.id,
      content: initial,
      metadata: buildMetadata("team", path, initial),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });
    const before = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          eq(aiVectors.sourceId, memory.id),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    const updated = "Different content. Updated body to verify upsert.";
    await vectorizeSource({
      sourceType: "memories",
      sourceId: memory.id,
      content: updated,
      metadata: buildMetadata("team", path, updated),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });
    const after = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          eq(aiVectors.sourceId, memory.id),
        ),
      );

    // Old rows must be gone (their content references "Initial").
    for (const row of after) {
      expect(row.content).not.toContain("Initial content");
    }
    expect(after.length).toBeGreaterThan(0);
  }, 180_000);
});
