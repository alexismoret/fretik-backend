/**
 * Full-pipeline integration tests for context-file vectorisation (S4).
 *
 * Mirrors the memory-test pattern: real DB, real OpenRouter (cheap
 * model for contextual enrichment + Qwen3-Embedding-8B for embeddings).
 * Slow (LLM round-trips) and requires:
 *   - Postgres reachable via DATABASE_URL
 *   - OPENROUTER_API_KEY set
 *   - Redis reachable via REDIS_URL (semaphore for cheap-model calls)
 *
 * Skip pattern: `bun test --test-name-pattern='context vectorize'` to
 * run these in isolation.
 */
import db from "@fretik/shared/db";
import {
  aiContextFiles,
  aiContextProfiles,
  aiVectors,
  type ContextVectorMetadata,
} from "@fretik/shared/db/schema";
import { deleteContextVectors } from "@fretik/shared/services/ai-context/vector-refresh";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { vectorizeSource } from "../../../../src/services/vectorize";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

const buildMetadata = (
  scope: "user" | "team",
  filename: string,
  profileId: string,
  content: string,
): ContextVectorMetadata => ({
  scope,
  filename,
  mime_type: "text/markdown",
  size_bytes: Buffer.byteLength(content, "utf8"),
  profile_id: profileId,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe("context vectorize (full pipeline)", () => {
  let fx: MemoryTestFixture;
  // The unique constraints `ai_context_profiles_team_org_unique` and
  // `ai_context_profiles_user_org_unique` mean we get exactly one
  // team profile and one user profile per fixture. Share both rows
  // across tests (each test attaches a uniquely-named file to the
  // relevant profile, which IS allowed because the file uniqueness
  // is on `(profileId, filename)`).
  let teamProfileId: string;
  let userProfileId: string;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
    const [userA] = fx.userIds;

    const [team] = await db
      .insert(aiContextProfiles)
      .values({
        scope: "team",
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: null,
        instructions: "",
        updatedById: userA,
      })
      .returning({ id: aiContextProfiles.id });
    if (!team) throw new Error("failed to insert shared team profile");
    teamProfileId = team.id;

    const [usr] = await db
      .insert(aiContextProfiles)
      .values({
        scope: "user",
        organizationId: fx.organizationId,
        teamId: null,
        userId: userA,
        instructions: "",
        updatedById: userA,
      })
      .returning({ id: aiContextProfiles.id });
    if (!usr) throw new Error("failed to insert shared user profile");
    userProfileId = usr.id;
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("team-scope context file: rows inserted with user_id NULL and [TEAM_CONTEXT] prefix", async () => {
    const [userA] = fx.userIds;
    const filename = "carriers-2026.md";
    const content =
      "# Carrier conventions 2026\n\n## DHL\n\nPrimary carrier on MRS→ANR.\n\nSLA: 48h door-to-door.\n\n## DPD\n\nFallback for parcels under 30kg.";

    const profile = { id: teamProfileId };

    const [file] = await db
      .insert(aiContextFiles)
      .values({
        profileId: profile.id,
        organizationId: fx.organizationId,
        filename,
        mimeType: "text/markdown",
        size: Buffer.byteLength(content, "utf8"),
        fileHash: Bun.SHA256.hash(content, "hex"),
        s3Key: `ai-context/${profile.id}/${filename}.md`,
        status: "ready",
        content,
        charCount: content.length,
        hasMarkdown: false,
        uploadedById: userA,
      })
      .returning();
    if (!file) throw new Error("failed to insert team context file");

    const result = await vectorizeSource({
      sourceType: "context",
      sourceId: file.id,
      content,
      metadata: buildMetadata("team", filename, profile.id, content),
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
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );

    expect(rows.length).toBe(result.rowsInserted);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.teamId).toBe(fx.teamId);
      expect(row.organizationId).toBe(fx.organizationId);
      expect(row.contextualPrefix).toContain("[TEAM_CONTEXT]");
      expect(row.contextualPrefix).toContain(`file:${filename}`);
    }
  }, 120_000);

  test("user-scope context file: rows inserted with user_id set, team_id NULL, and [USER_CONTEXT] prefix", async () => {
    const [userA] = fx.userIds;
    const filename = "personal-preferences.md";
    const content =
      "# My preferences\n\nDates en français. Distances en kilomètres. Notifications uniquement le matin.";

    const profile = { id: userProfileId };

    const [file] = await db
      .insert(aiContextFiles)
      .values({
        profileId: profile.id,
        organizationId: fx.organizationId,
        filename,
        mimeType: "text/markdown",
        size: Buffer.byteLength(content, "utf8"),
        fileHash: Bun.SHA256.hash(content, "hex"),
        s3Key: `ai-context/${profile.id}/${filename}.md`,
        status: "ready",
        content,
        charCount: content.length,
        hasMarkdown: false,
        uploadedById: userA,
      })
      .returning();
    if (!file) throw new Error("failed to insert user context file");

    const result = await vectorizeSource({
      sourceType: "context",
      sourceId: file.id,
      content,
      metadata: buildMetadata("user", filename, profile.id, content),
      teamId: null,
      organizationId: fx.organizationId,
      userId: userA,
    });

    expect(result.rowsInserted).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );

    expect(rows.length).toBe(result.rowsInserted);
    for (const row of rows) {
      expect(row.userId).toBe(userA);
      expect(row.teamId).toBeNull();
      expect(row.organizationId).toBe(fx.organizationId);
      expect(row.contextualPrefix).toContain("[USER_CONTEXT]");
      expect(row.contextualPrefix).toContain(`file:${filename}`);
    }
  }, 120_000);

  test("re-vectorising the same context file clears stale rows (idempotent upsert)", async () => {
    const [userA] = fx.userIds;
    const filename = "idempotent-context.md";
    const initial =
      "# Initial procedure\n\nStep 1: greet the carrier.\nStep 2: confirm the BL.";

    const profile = { id: teamProfileId };

    const [file] = await db
      .insert(aiContextFiles)
      .values({
        profileId: profile.id,
        organizationId: fx.organizationId,
        filename,
        mimeType: "text/markdown",
        size: Buffer.byteLength(initial, "utf8"),
        fileHash: Bun.SHA256.hash(initial, "hex"),
        s3Key: `ai-context/${profile.id}/${filename}.md`,
        status: "ready",
        content: initial,
        charCount: initial.length,
        hasMarkdown: false,
        uploadedById: userA,
      })
      .returning();
    if (!file) throw new Error("failed to insert idempotent file");

    await vectorizeSource({
      sourceType: "context",
      sourceId: file.id,
      content: initial,
      metadata: buildMetadata("team", filename, profile.id, initial),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });
    const before = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    const updated =
      "# Updated procedure\n\nStep 1: scan the BL.\nStep 2: confirm with ops by email.";
    await vectorizeSource({
      sourceType: "context",
      sourceId: file.id,
      content: updated,
      metadata: buildMetadata("team", filename, profile.id, updated),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });
    const after = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );

    // Old rows must be gone (their content references the initial body).
    for (const row of after) {
      expect(row.content).not.toContain("greet the carrier");
    }
    expect(after.length).toBeGreaterThan(0);
  }, 180_000);

  test("deleteContextVectors removes every chunk for the given fileId", async () => {
    const [userA] = fx.userIds;
    const filename = "to-be-deleted.md";
    const content =
      "# Disposable\n\nThis content should disappear from ai_vectors after the cascade hook fires.";

    const profile = { id: teamProfileId };

    const [file] = await db
      .insert(aiContextFiles)
      .values({
        profileId: profile.id,
        organizationId: fx.organizationId,
        filename,
        mimeType: "text/markdown",
        size: Buffer.byteLength(content, "utf8"),
        fileHash: Bun.SHA256.hash(content, "hex"),
        s3Key: `ai-context/${profile.id}/${filename}.md`,
        status: "ready",
        content,
        charCount: content.length,
        hasMarkdown: false,
        uploadedById: userA,
      })
      .returning();
    if (!file) throw new Error("failed to insert delete-target file");

    await vectorizeSource({
      sourceType: "context",
      sourceId: file.id,
      content,
      metadata: buildMetadata("team", filename, profile.id, content),
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
    });

    const before = await db
      .select({ id: aiVectors.id })
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    await deleteContextVectors(file.id);

    const after = await db
      .select({ id: aiVectors.id })
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, file.id),
        ),
      );
    expect(after.length).toBe(0);
  }, 120_000);
});
