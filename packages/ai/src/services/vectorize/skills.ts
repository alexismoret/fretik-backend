import db from "@fretik/shared/db";
import type { SkillVectorMetadata } from "@fretik/shared/db/schema";
import { aiVectors } from "@fretik/shared/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { vectorizeSource } from "./index";

/**
 * Skill-file vectoriser.
 *
 * Skills are GLOBAL rows in `ai_vectors` (`team_id IS NULL`,
 * `organization_id IS NULL`, `user_id IS NULL`) — the
 * `ai_vectors_scope_consistency` CHECK constraint guarantees this is
 * the only source kind allowed to omit the tenant scope.
 *
 * Identity & idempotence (per S3 architecture decision):
 *   - Lookup key = `(skill_name, skill_file)` tuple stored inside
 *     `metadata` JSONB. Each .md file in a bundled skill (SKILL.md +
 *     references/*.md) gets its OWN `source_id`, so a single file
 *     change doesn't force re-embedding the whole skill.
 *   - `getOrMintSourceId(name, file)` either re-uses the existing
 *     source_id for that tuple, or mints a fresh `Bun.randomUUIDv7()`.
 *   - `content_hash` (SHA-256 hex of the source markdown) is the
 *     short-circuit guard: if it hasn't changed since the previous
 *     indexing, we return early without re-embedding.
 *   - The DELETE-by-(sourceType, sourceId) baked into `upsertVectors`
 *     clears stale chunks of THIS file only; chunks of other files
 *     belonging to the same skill_name are untouched.
 *
 * Bulk cleanup (skill removed, file removed) is NOT done here — it
 * lives in `materialize.ts` where the boot hook diffs the in-memory
 * bundled set against the in-DB set and DELETEs the obsolete tuples.
 */

/**
 * Hex SHA-256 of the input string, the value stored in
 * `metadata.content_hash`. A NAMED algorithm on purpose: the hash is
 * persisted and compared across boots, so it must survive a Bun upgrade —
 * `Bun.hash`'s default is non-cryptographic AND unpinned, and a change to it
 * would invalidate every stored hash at once and re-embed the whole corpus.
 */
const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

interface SourceIdLookup {
  sourceId: string;
  existingHash: string | null;
}

const getOrMintSourceId = async (
  skillName: string,
  skillFile: string,
): Promise<SourceIdLookup> => {
  // We need any one row for that (skill_name, skill_file) tuple — every
  // chunk of the same file shares both the source_id AND the metadata
  // (vectorize service writes the same metadata object to every row),
  // so a single-row LIMIT 1 is enough for both fields.
  const rows = await db
    .select({
      sourceId: aiVectors.sourceId,
      metadata: aiVectors.metadata,
    })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "skills"),
        sql`${aiVectors.metadata}->>'skill_name' = ${skillName}`,
        sql`${aiVectors.metadata}->>'skill_file' = ${skillFile}`,
      ),
    )
    .limit(1);

  const existing = rows[0];
  if (existing) {
    const meta = existing.metadata as SkillVectorMetadata | null;
    return {
      sourceId: existing.sourceId,
      existingHash: meta?.content_hash ?? null,
    };
  }
  return { sourceId: Bun.randomUUIDv7(), existingHash: null };
};

export interface VectorizeSkillFileInput {
  /** Skill folder name (e.g. "xlsx", "data-viz"). */
  skillName: string;
  /** Path of the .md file relative to the skill folder ("SKILL.md" or "references/foo.md"). */
  skillFile: string;
  /** SKILL.md frontmatter description (used as the semantic-header tail). */
  description: string;
  /** Raw markdown content of the file. */
  content: string;
}

export interface VectorizeSkillFileResult {
  sourceId: string;
  /** True when this tuple had no rows before — i.e. brand-new file indexed for the first time. */
  created: boolean;
  /** True when the content_hash matched an existing row and the embed roundtrip was skipped. */
  skipped: boolean;
  /** Number of chunks produced by the upsert (0 when skipped). */
  chunksProduced: number;
}

export const vectorizeSkillFile = async (
  input: VectorizeSkillFileInput,
): Promise<VectorizeSkillFileResult> => {
  const contentHash = sha256Hex(input.content);
  const { sourceId, existingHash } = await getOrMintSourceId(
    input.skillName,
    input.skillFile,
  );

  if (existingHash === contentHash) {
    return { sourceId, created: false, skipped: true, chunksProduced: 0 };
  }

  const metadata: SkillVectorMetadata = {
    skill_name: input.skillName,
    skill_file: input.skillFile,
    skill_description: input.description,
    content_hash: contentHash,
    version_indexed_at: new Date().toISOString(),
  };

  const result = await vectorizeSource({
    sourceType: "skills",
    sourceId,
    content: input.content,
    metadata,
    teamId: null,
    organizationId: null,
    userId: null,
  });

  return {
    sourceId,
    created: existingHash === null,
    skipped: false,
    chunksProduced: result.chunksProduced,
  };
};

/**
 * Bulk-delete all rows for a (skill_name, skill_file) tuple. Used by
 * the boot-time cleanup in `materialize.ts` when a file or a whole
 * skill has been removed from the bundled set. Direct SQL is the
 * right tool here — the embed pipeline has nothing to do.
 */
export const deleteSkillFileVectors = async (
  skillName: string,
  skillFile: string,
): Promise<number> => {
  const deleted = await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "skills"),
        sql`${aiVectors.metadata}->>'skill_name' = ${skillName}`,
        sql`${aiVectors.metadata}->>'skill_file' = ${skillFile}`,
      ),
    )
    .returning({ id: aiVectors.id });
  return deleted.length;
};

/**
 * Returns the distinct (skill_name, skill_file) tuples currently
 * indexed under `source_type='skills'`. The boot-time cleanup diffs
 * this against the bundled set and deletes the tuples that fell out.
 */
export const listIndexedSkillFiles = async (): Promise<
  Array<{ skillName: string; skillFile: string }>
> => {
  const rows = await db
    .selectDistinct({
      skillName: sql<string>`${aiVectors.metadata}->>'skill_name'`,
      skillFile: sql<string>`${aiVectors.metadata}->>'skill_file'`,
    })
    .from(aiVectors)
    .where(eq(aiVectors.sourceType, "skills"));
  return rows;
};
