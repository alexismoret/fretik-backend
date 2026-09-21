import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import {
  aiConversationCheckpoints,
  aiConversations,
  aiMessages,
} from "../../../src/db/schema";
import {
  loadLatestCheckpoint,
  writeCheckpoint,
} from "../../../src/services/ai/checkpoints";
import { loadConversationForAgent } from "../../../src/services/ai/messages";
import { rewindConversationToUserMessage } from "../../../src/services/ai/rewind";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The persisted resume point, as SQL.
 *
 * Every assertion below dies when its clause is deleted from the query it
 * tests — that, and not the green run, is what says these test the query:
 *  - `gt(seq, checkpoint.upToSeq)` in `loadConversationForAgent` → `starts the
 *    window after the checkpoint`, which otherwise returns the whole history;
 *  - `ORDER BY up_to_seq DESC` + `LIMIT 1` in `loadLatestCheckpoint` → `reads
 *    the NEWEST checkpoint`, which otherwise returns whichever row the heap
 *    hands back;
 *  - the unique index on `(conversation_id, up_to_seq)` → `two writers at the
 *    same cut produce one row`;
 *  - `up_to_seq >= anchor.seq` in `deleteCheckpointsFrom` → `a rewind drops a
 *    checkpoint that sits exactly on the anchor`, the case the FK cascade
 *    cannot catch because the anchor row survives a rewind;
 *  - the `ON DELETE CASCADE` on `up_to_message_id` → `deleting the anchored
 *    message takes the checkpoint with it`.
 */

let fx: WorkspaceFixture;
let conversationId: string;
/** The conversation's owner — the only caller `rewind` accepts. */
let ownerId: string;

const seedMessage = async (
  role: "user" | "assistant",
  text: string,
  authorId?: string,
): Promise<{ id: string; seq: number }> => {
  const [row] = await db
    .insert(aiMessages)
    .values({
      conversationId,
      role,
      parts: [{ type: "text", text }],
      ...(authorId ? { authorId } : {}),
    })
    .returning({ id: aiMessages.id, seq: aiMessages.seq });
  if (!row) throw new Error("failed to seed message");
  return row;
};

const writeAt = async (
  cut: { id: string; seq: number },
  summary = "handover",
  generation = 1,
): Promise<boolean> =>
  writeCheckpoint({
    conversationId,
    upToMessageId: cut.id,
    upToSeq: cut.seq,
    summary,
    activatedTools: ["searchKnowledge"],
    participantIds: [],
    generation,
    kind: "llm",
    tokensBefore: 120_000,
    tokensAfter: 4_000,
  });

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  ownerId = fx.userIds[0];
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(async () => {
  const [conv] = await db
    .insert(aiConversations)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      agentType: "chatbot",
      title: "[it] checkpoints",
    })
    .returning({ id: aiConversations.id });
  if (!conv) throw new Error("failed to create conversation");
  conversationId = conv.id;
});

describe("the agent window, anchored on a checkpoint", () => {
  test("starts the window after the checkpoint", async () => {
    const first = await seedMessage("user", "old question", ownerId);
    await seedMessage("assistant", "old answer");
    const cut = await seedMessage("assistant", "cut here");
    await writeAt(cut);
    await seedMessage("user", "new question", ownerId);

    const window = await loadConversationForAgent(conversationId, 30);
    // Rows only — the summary and the activation replay are prepended by the
    // caller that knows what a model should see.
    expect(window.messages).toHaveLength(1);
    expect(window.checkpoint?.upToSeq).toBe(cut.seq);
    expect(window.messages.map((m) => m.id)).not.toContain(first.id);
  });

  test("with no checkpoint the window is the whole history", async () => {
    await seedMessage("user", "q", ownerId);
    await seedMessage("assistant", "a");
    const window = await loadConversationForAgent(conversationId, 30);
    expect(window.messages).toHaveLength(2);
    expect(window.checkpoint).toBeNull();
  });

  test("the cut is the window's last row, never the table's", async () => {
    // The defect this guards: a writer that asked the database for `MAX(seq)`
    // after the turn would summarise past the answer the turn just produced,
    // and that answer would land neither in the summary nor in the next
    // window. Here rows 3 and 4 stand for that answer.
    const a = await seedMessage("user", "q", ownerId);
    const b = await seedMessage("assistant", "a");
    const window = await loadConversationForAgent(conversationId, 30);
    const later = await seedMessage("assistant", "the turn's own reply");

    expect(window.cut).toEqual({ seq: b.seq, messageId: b.id });
    expect(window.cut?.seq).toBeLessThan(later.seq);
    expect(window.cut?.seq).toBeGreaterThan(a.seq - 1);
  });

  test("the cut stops at a row that can still change", async () => {
    await seedMessage("user", "q", ownerId);
    const settled = await seedMessage("assistant", "settled");
    const [partial] = await db
      .insert(aiMessages)
      .values({
        conversationId,
        role: "assistant",
        parts: [{ type: "text", text: "still streaming" }],
        metadata: { partial: true },
        turnId: crypto.randomUUID(),
      })
      .returning({ seq: aiMessages.seq });
    if (!partial) throw new Error("failed to seed partial");
    await seedMessage("assistant", "after the partial");

    const window = await loadConversationForAgent(conversationId, 30);
    expect(window.cut?.seq).toBe(settled.seq);
    expect(window.cut?.seq).toBeLessThan(partial.seq);
  });
});

describe("writing a checkpoint", () => {
  test("reads the NEWEST checkpoint, not any checkpoint", async () => {
    const older = await seedMessage("assistant", "older cut");
    const newer = await seedMessage("assistant", "newer cut");
    await writeAt(older, "older summary");
    await writeAt(newer, "newer summary", 2);

    const latest = await loadLatestCheckpoint(conversationId);
    expect(latest?.upToSeq).toBe(newer.seq);
    expect(latest?.summary).toBe("newer summary");
    expect(latest?.generation).toBe(2);
  });

  test("two writers at the same cut produce one row", async () => {
    // `/internal/invoke` never claims the stream slot and the workflow path
    // uses `forceSetConversationActiveStream`, so two turns on one
    // conversation are reachable. Both computing the same cut must not
    // produce two rows for the reader to choose between.
    const cut = await seedMessage("assistant", "cut");
    const [first, second] = await Promise.all([
      writeAt(cut, "from writer A"),
      writeAt(cut, "from writer B"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const rows = await db
      .select({ id: aiConversationCheckpoints.id })
      .from(aiConversationCheckpoints)
      .where(eq(aiConversationCheckpoints.conversationId, conversationId));
    expect(rows).toHaveLength(1);
  });

  test("a checkpoint belongs to its conversation and no other", async () => {
    const [other] = await db
      .insert(aiConversations)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: ownerId,
        agentType: "chatbot",
        title: "[it] checkpoints other",
      })
      .returning({ id: aiConversations.id });
    if (!other) throw new Error("failed to create second conversation");

    const cut = await seedMessage("assistant", "cut");
    await writeAt(cut);
    expect(await loadLatestCheckpoint(other.id)).toBeNull();
  });
});

describe("invalidation", () => {
  test("deleting the anchored message takes the checkpoint with it", async () => {
    const cut = await seedMessage("assistant", "cut");
    await writeAt(cut);
    await db.delete(aiMessages).where(eq(aiMessages.id, cut.id));
    expect(await loadLatestCheckpoint(conversationId)).toBeNull();
  });

  test("a rewind drops a checkpoint that sits exactly on the anchor", async () => {
    // The case the foreign key CANNOT catch: `rewind` keeps the anchor row and
    // re-saves it in place with the new wording, so a checkpoint cutting on it
    // survives the cascade while summarising the question the user replaced.
    // That is why `deleteCheckpointsFrom` uses `>=` and not `>`.
    const anchor = await seedMessage("user", "original wording", ownerId);
    await seedMessage("assistant", "answer to the original");
    await writeAt(anchor);

    const outcome = await rewindConversationToUserMessage({
      conversationId,
      messageId: anchor.id,
      userId: ownerId,
      countsAsEdit: true,
    });
    expect(outcome.ok).toBe(true);

    const survivor = await db
      .select({ id: aiMessages.id })
      .from(aiMessages)
      .where(eq(aiMessages.id, anchor.id));
    expect(survivor).toHaveLength(1);
    expect(await loadLatestCheckpoint(conversationId)).toBeNull();
  });

  test("a rewind leaves an older checkpoint alone", async () => {
    const older = await seedMessage("assistant", "settled long ago");
    await writeAt(older);
    const anchor = await seedMessage("user", "edit me", ownerId);
    await seedMessage("assistant", "answer");

    await rewindConversationToUserMessage({
      conversationId,
      messageId: anchor.id,
      userId: ownerId,
      countsAsEdit: true,
    });
    expect((await loadLatestCheckpoint(conversationId))?.upToSeq).toBe(
      older.seq,
    );
  });

  test("deleting the conversation takes its checkpoints with it", async () => {
    const cut = await seedMessage("assistant", "cut");
    await writeAt(cut);
    await db
      .delete(aiConversations)
      .where(eq(aiConversations.id, conversationId));
    const rows = await db
      .select({ id: aiConversationCheckpoints.id })
      .from(aiConversationCheckpoints)
      .where(eq(aiConversationCheckpoints.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  });
});
