/**
 * `buildMemoryIndexManifest` — depth-2 manifest with the empty-state
 * rendering. The 80-file global cap and the 30-files-per-dir collapse
 * are exercised here.
 *
 * Post-S6: this manifest is **no longer auto-injected into the system
 * prompt** (the `<persistent_memory>` block + `{{memoryIndex}}`
 * placeholder were removed; recall now flows through `searchKnowledge`
 * over the `ai_vectors` index built by S2's vectorize hook). The
 * function remains callable for the Settings/Debug UI surface, so the
 * caps + collapse logic still need coverage here.
 */
import db from "@fretik/shared/db";
import { aiMemories } from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { buildMemoryIndexManifest } from "@fretik/shared/services/ai-memory/list-index";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("buildMemoryIndexManifest", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("returns the empty-state hint when no memories exist", async () => {
    // Its OWN scope, like the cap test below. "Empty" is a property of a team
    // nobody has written to, so borrowing the shared fixture made this test a
    // claim about ORDER — it passed only while it happened to run before the
    // one that seeds three memories into that same team. `--randomize` put it
    // second and it read back `preferences.md` and `carriers/dhl.md`.
    const emptyFx = await createMemoryTestFixture();
    try {
      const out = await buildMemoryIndexManifest({
        organizationId: emptyFx.organizationId,
        teamId: emptyFx.teamId,
        userId: emptyFx.userIds[0],
      });
      expect(out).toContain("(no memories yet");
      expect(out).toContain("<memory_index>");
    } finally {
      await emptyFx.cleanup();
    }
  });

  test("renders user + team namespaces with depth-2 grouping", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    await createMemory({
      rawPath: "/memories/user/preferences.md",
      content: "kg",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/conventions.md",
      content: "BL = Bill of Lading",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/carriers/dhl.md",
      content: "DHL",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });

    const out = await buildMemoryIndexManifest({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    });
    expect(out).toContain("/memories/user/");
    expect(out).toContain("preferences.md");
    expect(out).toContain("/memories/team/");
    expect(out).toContain("conventions.md");
    expect(out).toContain("carriers/");
    expect(out).toContain("dhl.md");
  });

  test("collapses a directory above the per-dir file cap into a count summary", async () => {
    const [userA] = fx.userIds;
    const otherFx = await createMemoryTestFixture();
    // Seed 35 files via a single bulk INSERT — going through
    // `createMemory` would do 35 round-trips × 1 transaction each
    // and trip the default 5s test timeout on a busy machine.
    const rows = Array.from({ length: 35 }, (_, i) => ({
      organizationId: otherFx.organizationId,
      teamId: otherFx.teamId,
      scope: "team" as const,
      userId: null,
      path: `big/file-${i.toString().padStart(2, "0")}.md`,
      content: `entry ${i.toString()}`,
      sizeBytes: `entry ${i.toString()}`.length,
      createdByUserId: otherFx.userIds[0],
      createdByActor: "human" as const,
      lastModifiedByUserId: otherFx.userIds[0],
      lastModifiedByActor: "human" as const,
    }));
    await db.insert(aiMemories).values(rows);

    const out = await buildMemoryIndexManifest({
      organizationId: otherFx.organizationId,
      teamId: otherFx.teamId,
      userId: userA,
    });
    expect(out).toContain("big/  35 files");
    await otherFx.cleanup();
  });
});
