/**
 * Full-pipeline integration tests for skill vectorisation (S3).
 *
 * Hits the real DB AND real OpenRouter (cheap model for contextual
 * enrichment + Qwen3-Embedding-8B for embeddings). They are slow
 * (LLM round-trips) and require:
 *   - Postgres reachable via DATABASE_URL
 *   - OPENROUTER_API_KEY set
 *   - Redis reachable via REDIS_URL
 *
 * Skills are GLOBAL rows: team_id / organization_id / user_id all
 * NULL. The `ai_vectors_scope_consistency` CHECK constraint enforces
 * the (skills <=> all-NULL) invariant — one of the cases below
 * exercises it directly.
 *
 * All test fixtures use the prefix `test_skill_` on `metadata.skill_name`
 * so the global afterAll wipe never touches real bundled skills.
 */
import db from "@fretik/shared/db";
import { aiVectors } from "@fretik/shared/db/schema";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  deleteSkillFileVectors,
  listIndexedSkillFiles,
  vectorizeSkillFile,
} from "../../../../src/services/vectorize/skills";

const TEST_PREFIX = "test_skill_";

const uniqueSkillName = (label: string): string =>
  `${TEST_PREFIX}${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const countRowsForTuple = async (
  skillName: string,
  skillFile: string,
): Promise<number> => {
  const rows = await db
    .select({ id: aiVectors.id })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "skills"),
        sql`${aiVectors.metadata}->>'skill_name' = ${skillName}`,
        sql`${aiVectors.metadata}->>'skill_file' = ${skillFile}`,
      ),
    );
  return rows.length;
};

describe("skill vectorize (full pipeline)", () => {
  afterAll(async () => {
    // Wipe every test-fixture row across the suite (test_skill_* prefix
    // guarantees we never touch real bundled skills).
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "skills"),
          sql`${aiVectors.metadata}->>'skill_name' LIKE ${`${TEST_PREFIX}%`}`,
        ),
      );
  });

  test("fresh single-file skill: rows inserted with NULL scope columns and [SKILL:..] prefix", async () => {
    const skillName = uniqueSkillName("fresh");
    const description =
      "Test skill: generate a CSV invoice from a list of line items.";
    const content =
      "## Test skill\n\nThis skill produces a CSV invoice.\n\nUse pandas.DataFrame.to_csv() with index=False.";

    const result = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content,
    });

    expect(result.created).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.chunksProduced).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "skills"),
          sql`${aiVectors.metadata}->>'skill_name' = ${skillName}`,
        ),
      );
    expect(rows.length).toBe(result.chunksProduced);
    for (const row of rows) {
      expect(row.teamId).toBeNull();
      expect(row.organizationId).toBeNull();
      expect(row.userId).toBeNull();
      expect(row.sourceId).toBe(result.sourceId);
      expect(row.contextualPrefix).toContain(`[SKILL:${skillName}/SKILL.md]`);
      expect(row.contextualPrefix).toContain(description);
    }
  }, 120_000);

  test("re-vectorise same file with identical content: no-op short-circuit (skipped, 0 chunks)", async () => {
    const skillName = uniqueSkillName("noop");
    const description = "Idempotent skill — content never changes.";
    const content =
      "## Idempotent\n\nFixed body. Re-vectorising must skip the embed roundtrip.";

    const first = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content,
    });
    expect(first.created).toBe(true);
    const beforeCount = await countRowsForTuple(skillName, "SKILL.md");
    expect(beforeCount).toBe(first.chunksProduced);

    const second = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content,
    });
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.chunksProduced).toBe(0);
    expect(second.sourceId).toBe(first.sourceId);

    const afterCount = await countRowsForTuple(skillName, "SKILL.md");
    expect(afterCount).toBe(beforeCount);
  }, 180_000);

  test("re-vectorise same file with modified content: same source_id, stale chunks cleared, new chunks inserted", async () => {
    const skillName = uniqueSkillName("update");
    const description = "Skill whose content evolves between versions.";
    const initial =
      "## Initial\n\nFirst version of the skill body. References pandas.";
    const updated =
      "## Updated\n\nSecond version. Now references openpyxl instead of pandas.";

    const first = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: initial,
    });
    const second = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: updated,
    });

    expect(second.sourceId).toBe(first.sourceId);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(false);
    expect(second.chunksProduced).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "skills"),
          eq(aiVectors.sourceId, first.sourceId),
        ),
      );
    for (const row of rows) {
      expect(row.content).not.toContain("First version");
    }
  }, 180_000);

  test("multiple files of the same skill: distinct source_id per file, neither wipes the other", async () => {
    const skillName = uniqueSkillName("multi");
    const description = "Multi-file skill (SKILL.md + references/foo.md).";
    const skillMdBody =
      "## Multi-file skill\n\nMain entry. See references/foo.md for details.";
    const referenceBody =
      "## Reference foo\n\nDeeper content used on demand by the main SKILL.md.";

    const main = await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: skillMdBody,
    });
    const ref = await vectorizeSkillFile({
      skillName,
      skillFile: "references/foo.md",
      description,
      content: referenceBody,
    });

    expect(main.sourceId).not.toBe(ref.sourceId);

    const mainCount = await countRowsForTuple(skillName, "SKILL.md");
    const refCount = await countRowsForTuple(skillName, "references/foo.md");
    expect(mainCount).toBe(main.chunksProduced);
    expect(refCount).toBe(ref.chunksProduced);
  }, 240_000);

  test("CHECK ai_vectors_scope_consistency: tenant scope on a skills row is rejected by PG", async () => {
    // Bypass the service layer and INSERT raw SQL directly to exercise
    // the DB-level constraint. We use raw SQL (not the drizzle builder)
    // because (1) the FK on team_id would fire first if we used a real
    // team UUID, masking the CHECK violation, and (2) the builder's
    // thenable doesn't compose cleanly with `expect(...).rejects`.
    let caught: unknown = null;
    try {
      await db.execute(sql`
        INSERT INTO ai_vectors
          (content, contextual_prefix, chunk_index, total_chunks,
           source_type, source_id, metadata, team_id, organization_id, user_id)
        VALUES
          ('violates check', '', 0, 1,
           'skills', uuid_generate_v7(), '{}'::jsonb,
           '00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000001',
           NULL)
      `);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Drizzle wraps PG errors as `Error("Failed query: …")` and exposes
    // the original on `cause`. The CHECK constraint name shows up on
    // the cause's message — pick the deepest message in the chain.
    const collectMessages = (err: unknown): string[] => {
      const out: string[] = [];
      let cur: unknown = err;
      while (cur instanceof Error) {
        out.push(cur.message);
        cur = (cur as Error & { cause?: unknown }).cause;
      }
      return out;
    };
    const messages = collectMessages(caught).join("\n");
    expect(messages).toContain("ai_vectors_scope_consistency");
  }, 30_000);

  test("cleanup: deleteSkillFileVectors removes only the targeted (skill_name, skill_file) tuple", async () => {
    const skillName = uniqueSkillName("partial");
    const description = "Skill where one of the files will be retired.";
    await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: "## Keep\n\nThis SKILL.md stays after cleanup.",
    });
    await vectorizeSkillFile({
      skillName,
      skillFile: "references/old.md",
      description,
      content:
        "## Drop\n\nThis references/old.md is the retired file in this scenario.",
    });

    const beforeMain = await countRowsForTuple(skillName, "SKILL.md");
    const beforeOld = await countRowsForTuple(skillName, "references/old.md");
    expect(beforeMain).toBeGreaterThan(0);
    expect(beforeOld).toBeGreaterThan(0);

    const deleted = await deleteSkillFileVectors(
      skillName,
      "references/old.md",
    );
    expect(deleted).toBe(beforeOld);

    const afterMain = await countRowsForTuple(skillName, "SKILL.md");
    const afterOld = await countRowsForTuple(skillName, "references/old.md");
    expect(afterMain).toBe(beforeMain);
    expect(afterOld).toBe(0);
  }, 240_000);

  test("listIndexedSkillFiles surfaces every (skill_name, skill_file) tuple currently indexed", async () => {
    const skillName = uniqueSkillName("listed");
    const description = "Skill registered solely to verify discovery.";
    await vectorizeSkillFile({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: "## Listed\n\nUsed by the listIndexedSkillFiles assertion.",
    });

    const tuples = await listIndexedSkillFiles();
    const found = tuples.find(
      (t) => t.skillName === skillName && t.skillFile === "SKILL.md",
    );
    expect(found).toBeDefined();
  }, 120_000);
});
