import { and, eq, inArray, notInArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { AiEpisode, AiEpisodeKind } from "../../db/schema";
import { aiEpisodeRecords, aiEpisodes } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { redactSecrets } from "../../lib/redact-secrets";
import { emitDomainEvent, SYSTEM_ACTOR } from "../domain-events/emit";

const MAX_TITLE_CHARS = 200;

/**
 * Hard guard against distiller runaway — NOT the target length (the distill
 * prompt aims ~1500 chars). 4000 chars ≈ 1000 tokens ≈ exactly two chunks of
 * the vectorize chunker (~2000 chars each), so an episode costs at most two
 * ai_vectors rows; the recall judge reads chunks, never whole episodes, so
 * this cap never touches prompt size.
 */
const MAX_SUMMARY_CHARS = 4_000;

/**
 * Salience bound, not storage. Callers pass record ids ORDERED by salience
 * (the distiller ranks them), so the slice keeps the most important ones. A
 * conversation "about" more than 25 records is indiscriminate listing (bulk
 * imports), which would dilute the recall graph arm ("recent episodes about
 * this record") for every record it brushed.
 */
const MAX_EPISODE_RECORDS = 25;

const contentHashOf = (title: string, summary: string): string =>
  new Bun.CryptoHasher("sha256").update(`${title}\n${summary}`).digest("hex");

export interface UpsertEpisodeResult {
  episode: AiEpisode;
  /** False when the content hash is unchanged — caller skips the re-embed. */
  contentChanged: boolean;
}

/**
 * Create or refresh an episode. The upsert key is kind-dependent (the active
 * partial unique indexes): `conversation` episodes key on `conversationId`,
 * `record_activity` on `anchorRecordId`, `consolidated` always inserts.
 * Re-distillation is a full replace of title/summary/window/records;
 * `contentHash` short-circuits the caller's vectorize roundtrip when nothing
 * changed. Journals `episode.created` on first creation only (consolidation
 * emits its own `episode.consolidated`).
 */
export const upsertEpisode = async (input: {
  organizationId: string;
  teamId: string;
  /** Set = private to that user (single-member conversation episodes). */
  userId?: string | null;
  kind: AiEpisodeKind;
  title: string;
  summary: string;
  conversationId?: string | null;
  anchorRecordId?: string | null;
  occurredFrom?: Date | null;
  occurredTo?: Date | null;
  /** Records the episode is about, ordered by salience — replaces the set. */
  recordIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<UpsertEpisodeResult> => {
  // Redact credential-shaped strings before anything persists — the last net
  // under the distill prompts' sensitivity guard (P8.2). Redact BEFORE the
  // slice so a secret straddling the cap is still caught.
  const title = redactSecrets(input.title).slice(0, MAX_TITLE_CHARS);
  const summary = redactSecrets(input.summary).slice(0, MAX_SUMMARY_CHARS);
  const contentHash = contentHashOf(title, summary);
  const recordIds = [...new Set(input.recordIds ?? [])].slice(
    0,
    MAX_EPISODE_RECORDS,
  );

  return db.transaction(async (tx) => {
    const existing =
      input.kind === "conversation" && input.conversationId
        ? await tx.query.aiEpisodes.findFirst({
            where: {
              kind: "conversation",
              state: "active",
              conversationId: input.conversationId,
            },
          })
        : input.kind === "record_activity" && input.anchorRecordId
          ? await tx.query.aiEpisodes.findFirst({
              where: {
                kind: "record_activity",
                state: "active",
                anchorRecordId: input.anchorRecordId,
              },
            })
          : undefined;

    let episode: AiEpisode;
    if (existing) {
      const [updated] = await tx
        .update(aiEpisodes)
        .set({
          title,
          summary,
          contentHash,
          userId: input.userId ?? null,
          occurredFrom: input.occurredFrom ?? existing.occurredFrom,
          occurredTo: input.occurredTo ?? existing.occurredTo,
          metadata: input.metadata ?? existing.metadata,
        })
        .where(eq(aiEpisodes.id, existing.id))
        .returning();
      if (!updated) return throwHttpError(500, internalError());
      episode = updated;
    } else {
      const [created] = await tx
        .insert(aiEpisodes)
        .values({
          organizationId: input.organizationId,
          teamId: input.teamId,
          userId: input.userId ?? null,
          kind: input.kind,
          title,
          summary,
          conversationId: input.conversationId ?? null,
          anchorRecordId: input.anchorRecordId ?? null,
          occurredFrom: input.occurredFrom ?? null,
          occurredTo: input.occurredTo ?? null,
          contentHash,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!created) return throwHttpError(500, internalError());
      episode = created;
      await emitDomainEvent({
        tx,
        organizationId: input.organizationId,
        teamId: input.teamId,
        type: "episode.created",
        actor: SYSTEM_ACTOR,
        subjectType: "episode",
        payload: { episodeId: episode.id, kind: episode.kind, title },
        dedupKey: `episode.created:${episode.id}`,
      });
    }

    // Replace the record set: drop stale edges, add missing ones.
    if (recordIds.length === 0) {
      await tx
        .delete(aiEpisodeRecords)
        .where(eq(aiEpisodeRecords.episodeId, episode.id));
    } else {
      await tx
        .delete(aiEpisodeRecords)
        .where(
          and(
            eq(aiEpisodeRecords.episodeId, episode.id),
            notInArray(aiEpisodeRecords.recordId, recordIds),
          ),
        );
      await tx
        .insert(aiEpisodeRecords)
        .values(
          recordIds.map((recordId) => ({ episodeId: episode.id, recordId })),
        )
        .onConflictDoNothing({
          target: [aiEpisodeRecords.episodeId, aiEpisodeRecords.recordId],
        });
    }

    return {
      episode,
      contentChanged: !existing || existing.contentHash !== contentHash,
    };
  });
};

/** Load the record ids an episode anchors on (vector metadata + UI). */
export const getEpisodeRecordIds = async (
  episodeId: string,
): Promise<string[]> => {
  const rows = await db
    .select({ recordId: aiEpisodeRecords.recordId })
    .from(aiEpisodeRecords)
    .where(eq(aiEpisodeRecords.episodeId, episodeId));
  return rows.map((r) => r.recordId);
};

/**
 * Mark episodes superseded by a consolidation survivor — non-destructive
 * invalidation (Zep-style): the rows keep their content, only leave the
 * active set. Caller deletes their vectors.
 */
export const supersedeEpisodes = async (input: {
  episodeIds: string[];
  supersededById: string;
  tx?: Transaction;
}): Promise<void> => {
  if (input.episodeIds.length === 0) return;
  const exec = input.tx ?? db;
  await exec
    .update(aiEpisodes)
    .set({ state: "superseded", supersededById: input.supersededById })
    .where(inArray(aiEpisodes.id, input.episodeIds));
};
