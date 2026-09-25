import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { saveMessage } from "../../../src/services/ai/messages";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The upsert behind a sent message keeps the CLIENT's id, so a re-send
 * converges onto the bubble already on screen. The same id sent by another
 * participant used to converge too — replacing the text of a colleague's
 * message, or of an assistant reply, while its author and role stayed as they
 * were. Both authors below are participants of the same conversation; only the
 * author differs.
 */

let fx: WorkspaceFixture;
let conversationId: string;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  conversationId = (await fx.createConversation()).id;
});

afterAll(async () => {
  await fx.cleanup();
});

const textOf = async (id: string): Promise<string | undefined> => {
  const row = await db.query.aiMessages.findFirst({
    columns: { parts: true },
    where: { id },
  });
  const part = row?.parts[0];
  return part?.type === "text" ? part.text : undefined;
};

const say = (text: string) => [{ type: "text" as const, text }];

describe("a re-sent message converges only onto its own author's row", () => {
  test("the author's re-send refreshes their message", async () => {
    const [author] = fx.userIds;
    const saved = await saveMessage({
      conversationId,
      role: "user",
      parts: say("first draft"),
      authorId: author,
    });
    if (!saved) throw new Error("fixture: message not saved");

    await saveMessage({
      id: saved.id,
      conversationId,
      role: "user",
      parts: say("final text"),
      authorId: author,
    });

    expect(await textOf(saved.id)).toBe("final text");
  });

  test("another participant cannot rewrite it under its id", async () => {
    const [author, other] = fx.userIds;
    const saved = await saveMessage({
      conversationId,
      role: "user",
      parts: say("what I said"),
      authorId: author,
    });
    if (!saved) throw new Error("fixture: message not saved");

    const forged = await saveMessage({
      id: saved.id,
      conversationId,
      role: "user",
      parts: say("words put in my mouth"),
      authorId: other,
    });

    expect(forged).toBeUndefined();
    expect(await textOf(saved.id)).toBe("what I said");
  });

  test("a user message cannot overwrite an assistant reply", async () => {
    const [author] = fx.userIds;
    const reply = await saveMessage({
      conversationId,
      role: "assistant",
      parts: say("the assistant's answer"),
    });
    if (!reply) throw new Error("fixture: reply not saved");

    await saveMessage({
      id: reply.id,
      conversationId,
      role: "user",
      parts: say("a rewritten answer"),
      authorId: author,
    });

    expect(await textOf(reply.id)).toBe("the assistant's answer");
  });
});
