import db from "@fretik/shared/db";
import {
  aiEpisodeRecords,
  aiEpisodes,
  aiMemories,
} from "@fretik/shared/db/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadExistingLearned } from "../../../../src/services/memory/promote-episodes";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

/**
 * What the promoter's dedup gate is allowed to read.
 *
 * Integration, because every claim here is a `WHERE` clause or a join, and the
 * house rule applies: if an assertion still holds after its predicate is
 * deleted, it is not testing the query. The prompt block is a `map().join()`
 * of this list, so this is where the behaviour lives.
 *
 * The pairs are one test each on purpose. The gate's prompt says "NOOP: …  or
 * already covered", so what costs a promotion is an UNRELATED memory reaching
 * it — but an exclusion alone is satisfied by a function that returns nothing,
 * which would cost every promotion instead. Both halves, or neither.
 */

let fx: MemoryTestFixture;

const seedEpisode = async (recordId: string): Promise<string> => {
  const [row] = await db
    .insert(aiEpisodes)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      kind: "conversation",
      title: "[test] episode",
      summary: "what happened",
      contentHash: randomUUID(),
    })
    .returning({ id: aiEpisodes.id });
  if (!row) throw new Error("failed to insert episode");
  await db.insert(aiEpisodeRecords).values({ episodeId: row.id, recordId });
  return row.id;
};

const seedLearned = async (values: {
  path: string;
  /** The provenance line verbatim — the gate reads it back to find a subject. */
  sources: string;
  scope?: "team" | "user";
  userId?: string;
  updatedAt?: Date;
}): Promise<void> => {
  const content = `A durable rule.\n\nSources: ${values.sources}`;
  await db.insert(aiMemories).values({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    scope: values.scope ?? "team",
    userId: values.userId ?? null,
    path: values.path,
    content,
    sizeBytes: new TextEncoder().encode(content).length,
    createdByActor: "agent",
    lastModifiedByActor: "agent",
    ...(values.updatedAt
      ? { createdAt: values.updatedAt, updatedAt: values.updatedAt }
      : {}),
  });
};

const pathsFor = async (
  anchorRecordIds: string[],
  scope: "team" | "user" = "team",
  userId: string | null = null,
): Promise<string[]> => {
  const rows = await loadExistingLearned({
    teamId: fx.teamId,
    scope,
    userId,
    anchorRecordIds,
  });
  return rows.map((r) => r.path);
};

// A workspace PER TEST: these tests differ by what ELSE is in the namespace,
// so one test's rows are the next one's contamination — which is the very
// failure this filter exists to stop.
beforeEach(async () => {
  fx = await createMemoryTestFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

describe("subject", () => {
  test("keeps a promotion about THIS record and drops one about another", async () => {
    // The measured failure, 2026-09-11: one `learned/` file about another
    // company, left by another suite, and the gate answered `{"promotions":[]}`
    // ten times out of ten on a cluster it had promoted the day before.
    const mine = await fx.createRecord("Subject");
    const other = await fx.createRecord("Somebody else");
    await seedLearned({
      path: "learned/mine.md",
      sources: `episode:${await seedEpisode(mine)}`,
    });
    await seedLearned({
      path: "learned/other.md",
      sources: `episode:${await seedEpisode(other)}`,
    });

    expect(await pathsFor([mine])).toEqual(["learned/mine.md"]);
  });

  test("drops a memory whose provenance names no resolvable episode", async () => {
    // The fallback is EMPTY, never "all" — "all" is the behaviour being fixed.
    const mine = await fx.createRecord();
    await seedLearned({
      path: "learned/unsourced.md",
      sources: "episode:seed",
    });
    await seedLearned({
      path: "learned/sourced.md",
      sources: `episode:${await seedEpisode(mine)}`,
    });

    expect(await pathsFor([mine])).toEqual(["learned/sourced.md"]);
  });

  test("a match survives a wall of newer, unrelated promotions", async () => {
    // Why the read window is far wider than the prompt budget: the cut that
    // decides what the model sees has to be topical. Ordered by recency and
    // cut at the budget FIRST, this memory is gone and the gate re-adds a
    // duplicate of itself under a new path.
    const mine = await fx.createRecord();
    const other = await fx.createRecord();
    await seedLearned({
      path: "learned/mine.md",
      sources: `episode:${await seedEpisode(mine)}`,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const otherEpisode = await seedEpisode(other);
    // More than the 20 that reach the prompt, every one of them newer.
    for (let i = 0; i < 25; i++) {
      await seedLearned({
        path: `learned/noise-${i.toString()}.md`,
        sources: `episode:${otherEpisode}`,
        updatedAt: new Date(`2026-06-${(i + 1).toString().padStart(2, "0")}`),
      });
    }

    expect(await pathsFor([mine])).toEqual(["learned/mine.md"]);
  });
});

describe("scope", () => {
  test("a team-scope load never reads a user's private learned memory", async () => {
    // The promoter WRITES from what it reads here, so a private memory
    // reaching a team-scope pass is a private fact rewritten into a
    // team-shared one.
    const mine = await fx.createRecord();
    const [me] = fx.userIds;
    await seedLearned({
      path: "learned/private.md",
      sources: `episode:${await seedEpisode(mine)}`,
      scope: "user",
      userId: me,
    });

    expect(await pathsFor([mine])).toEqual([]);
    expect(await pathsFor([mine], "user", me)).toEqual(["learned/private.md"]);
  });
});
