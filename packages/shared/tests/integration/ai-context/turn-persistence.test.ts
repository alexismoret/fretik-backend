import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { aiMessages } from "../../../src/db/schema";
import {
  deleteStalePartialMessages,
  saveMessages,
} from "../../../src/services/ai/messages";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The end of a chat turn, as SQL.
 *
 * Two writes settle a turn, in one transaction: the authoritative message row
 * (which drops the `partial` flag the incremental recorder has been setting
 * every couple of seconds) and the removal of any partial row the turn left
 * behind under a stale wire id. The second used to be written as
 * `id <> ALL($1::uuid[])`, with the id list bound as a SINGLE parameter — the
 * driver sent a bare uuid string, Postgres wanted an array literal, and the
 * statement raised `malformed array literal` on EVERY turn that produced
 * exactly one assistant message. That is every ordinary turn.
 *
 * Because the two writes share a transaction, the failure took the first one
 * with it: the finished answer was rolled back to the recorder's partial rows,
 * so a complete reply came back from a reload wearing an "interrupted" badge,
 * and (until the slot release was moved out of the transaction's blast radius)
 * the conversation refused every later prompt with a 409.
 *
 * These run against a real Postgres on purpose. A double would have accepted
 * the malformed cast happily — the bug lived entirely in what the server made
 * of the parameter, which is precisely what a fake cannot have an opinion on.
 */

let fixture: WorkspaceFixture;
let conversationId: string;

beforeAll(async () => {
  fixture = await createWorkspaceFixture();
  const conversation = await fixture.createConversation();
  conversationId = conversation.id;
});

afterAll(async () => {
  await fixture.cleanup();
});

const partialRow = async (turnId: string, id: string): Promise<void> => {
  await db.insert(aiMessages).values({
    id,
    conversationId,
    role: "assistant",
    parts: [{ type: "text", text: "half of an answer" }],
    metadata: { partial: true, turnId },
    turnId,
  });
};

const rowsOfTurn = async (
  turnId: string,
): Promise<{ id: string; partial: boolean }[]> => {
  const rows = await db
    .select({ id: aiMessages.id, metadata: aiMessages.metadata })
    .from(aiMessages)
    .where(eq(aiMessages.turnId, turnId));
  return rows.map((r) => ({
    id: r.id,
    partial: r.metadata?.partial === true,
  }));
};

describe("deleteStalePartialMessages", () => {
  test("keeping ONE id runs — the shape every ordinary turn takes", async () => {
    const turnId = crypto.randomUUID();
    const keep = crypto.randomUUID();
    const stale = crypto.randomUUID();
    await partialRow(turnId, keep);
    await partialRow(turnId, stale);

    const deleted = await deleteStalePartialMessages({
      conversationId,
      turnId,
      keepIds: [keep],
    });

    expect(deleted).toBe(1);
    expect((await rowsOfTurn(turnId)).map((r) => r.id)).toEqual([keep]);
  });

  test("keeping several ids runs too", async () => {
    const turnId = crypto.randomUUID();
    const keepA = crypto.randomUUID();
    const keepB = crypto.randomUUID();
    const stale = crypto.randomUUID();
    await partialRow(turnId, keepA);
    await partialRow(turnId, keepB);
    await partialRow(turnId, stale);

    const deleted = await deleteStalePartialMessages({
      conversationId,
      turnId,
      keepIds: [keepA, keepB],
    });

    expect(deleted).toBe(1);
    expect((await rowsOfTurn(turnId)).map((r) => r.id).sort()).toEqual(
      [keepA, keepB].sort(),
    );
  });

  test("a FINISHED row is never deleted, whatever the keep list says", async () => {
    const turnId = crypto.randomUUID();
    const finished = crypto.randomUUID();
    await db.insert(aiMessages).values({
      id: finished,
      conversationId,
      role: "assistant",
      parts: [{ type: "text", text: "a complete answer" }],
      metadata: { turnId },
      turnId,
    });

    const deleted = await deleteStalePartialMessages({
      conversationId,
      turnId,
      keepIds: [crypto.randomUUID()],
    });

    expect(deleted).toBe(0);
    expect(await rowsOfTurn(turnId)).toEqual([
      { id: finished, partial: false },
    ]);
  });

  test("the turn settles as one transaction: flag cleared, stale row gone", async () => {
    const turnId = crypto.randomUUID();
    const finalId = crypto.randomUUID();
    const renamedAway = crypto.randomUUID();
    await partialRow(turnId, finalId);
    await partialRow(turnId, renamedAway);

    // What `onFinish` does, in the order it does it.
    await db.transaction(async (tx) => {
      await saveMessages(
        conversationId,
        [
          {
            id: finalId,
            role: "assistant",
            parts: [{ type: "text", text: "the whole answer" }],
            metadata: { langfuseTraceId: "trace-1" },
            turnId,
          },
        ],
        tx,
      );
      await deleteStalePartialMessages({
        conversationId,
        turnId,
        keepIds: [finalId],
        tx,
      });
    });

    // The flag is what the UI reads to draw "interrupted". It must be gone.
    expect(await rowsOfTurn(turnId)).toEqual([{ id: finalId, partial: false }]);
  });
});
