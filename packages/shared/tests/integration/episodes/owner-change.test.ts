import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import { aiVectors } from "../../../src/db/schema";
import { upsertEpisode } from "../../../src/services/episodes/upsert";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * An episode's reader is its `user_id` — and its vectors', which search reads.
 * A chat's episode that used to be the whole team's (a chat of several, before
 * a chat became its participants') becomes its owner's on its next
 * distillation: its vectors must change hands with it, even when the summary
 * is the same and nothing is embedded again.
 */

let fx: WorkspaceFixture;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

const readerOfVectors = async (episodeId: string) => {
  const rows = await db
    .select({ userId: aiVectors.userId })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "episodes"),
        eq(aiVectors.sourceId, episodeId),
      ),
    );
  return rows.map((row) => row.userId);
};

describe("an episode whose owner changes", () => {
  test("takes its vectors with it, though its summary is unchanged", async () => {
    const [ownerId] = fx.userIds;
    const conversationId = (await fx.createConversation()).id;
    const episode = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      kind: "conversation" as const,
      title: "Quarterly review",
      summary: "The team agreed on the quarterly targets.",
      conversationId,
    };
    const first = await upsertEpisode({ ...episode, userId: null });
    await db.insert(aiVectors).values({
      sourceType: "episodes",
      sourceId: first.episode.id,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: null,
      content: episode.summary,
      contextualPrefix: "",
      chunkIndex: 0,
      totalChunks: 1,
      metadata: {
        kind: "conversation",
        title: episode.title,
        conversation_id: conversationId,
        anchor_record_id: null,
        occurred_from: null,
        occurred_to: null,
      },
    });

    const second = await upsertEpisode({ ...episode, userId: ownerId });

    expect(second.episode.id).toBe(first.episode.id);
    expect(second.contentChanged).toBe(false);
    expect(await readerOfVectors(first.episode.id)).toEqual([ownerId]);
  });
});
