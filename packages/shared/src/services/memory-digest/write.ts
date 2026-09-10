import { sql } from "drizzle-orm";
import db from "../../db";
import { teamMemoryDigests } from "../../db/schema";
import type {
  TeamMemoryDigest,
  TeamMemoryDigestSources,
} from "../../db/schema/team-memory-digest";

export interface WriteTeamDigestInput {
  organizationId: string;
  teamId: string;
  content: string;
  tokenCount: number;
  sourceFingerprint: string;
  sources: TeamMemoryDigestSources;
  modelProfileKey?: string;
}

/**
 * Replace a team's digest, keeping the one it replaced.
 *
 * A single upsert rather than read-then-write: two jobs can race for the same
 * team (the nightly pass and a debounced refresh triggered by a memory write),
 * and a read-modify-write would let the slower one resurrect an older digest
 * with a NEWER version number — which is the one shape that would make the
 * version column lie.
 *
 * `previous_content` takes the row's own current `content` inside the same
 * statement, so the rollback copy is always exactly what was being served a
 * moment ago, never a value the caller had to fetch and carry.
 *
 * Writing also CLEARS `stale_at`: reaching here means a usable digest was
 * produced, and a stale marker that outlives the problem it described sends
 * the next reader hunting for a failure that already resolved.
 */
export const writeTeamDigest = async (
  input: WriteTeamDigestInput,
): Promise<TeamMemoryDigest> => {
  const [row] = await db
    .insert(teamMemoryDigests)
    .values({
      teamId: input.teamId,
      organizationId: input.organizationId,
      content: input.content,
      tokenCount: input.tokenCount,
      sourceFingerprint: input.sourceFingerprint,
      sources: input.sources,
      modelProfileKey: input.modelProfileKey ?? null,
      version: 1,
    })
    .onConflictDoUpdate({
      target: teamMemoryDigests.teamId,
      set: {
        content: sql`excluded.content`,
        previousContent: sql`${teamMemoryDigests.content}`,
        tokenCount: sql`excluded.token_count`,
        sourceFingerprint: sql`excluded.source_fingerprint`,
        sources: sql`excluded.sources`,
        modelProfileKey: sql`excluded.model_profile_key`,
        version: sql`${teamMemoryDigests.version} + 1`,
        generatedAt: sql`now()`,
        staleAt: sql`NULL`,
      },
    })
    .returning();

  if (!row) throw new Error("writeTeamDigest returned no row");
  return row;
};

/**
 * Mark the current digest as not-refreshed, without touching what it says.
 *
 * The failure this exists for is quiet: the generator returned nothing usable
 * (empty completion, `finishReason: "length"`, a provenance marker that did not
 * resolve). Serving the previous digest is right — a slightly old summary beats
 * none — but a digest that silently stops being maintained looks identical to a
 * team that stopped changing, and the two want very different responses.
 */
export const markTeamDigestStale = async (teamId: string): Promise<void> => {
  await db
    .update(teamMemoryDigests)
    .set({ staleAt: sql`now()` })
    .where(sql`${teamMemoryDigests.teamId} = ${teamId}`);
};
