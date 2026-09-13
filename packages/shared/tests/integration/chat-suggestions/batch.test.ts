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
import { chatSuggestions } from "../../../src/db/schema";
import { getActiveSuggestionBatch } from "../../../src/services/chat-suggestions/get-active-batch";
import { listRecentSuggestionLabels } from "../../../src/services/chat-suggestions/list-recent-feedback";
import { markChatSuggestion } from "../../../src/services/chat-suggestions/mark";
import { replaceSuggestionBatch } from "../../../src/services/chat-suggestions/replace-batch";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * The suggestion store, whose whole correctness is in four `where` clauses.
 *
 * The one that matters most is `user_id`. These rows are generated from a
 * context carrying the reader's PRIVATE episodes and memories, and their ids
 * reach the browser — so a colleague who can guess an id must not be able to
 * read, resolve or otherwise touch one. Deleting that predicate from
 * `mark.ts` or `get-active-batch.ts` reddens this file.
 *
 * The second is the supersede: a batch that replaces another must leave
 * exactly one generation `active`, or the home screen shows two.
 */

let fx: WorkspaceFixture;

const items = (prefix: string) => [
  {
    kind: "pending" as const,
    label: `${prefix} approve the run`,
    prompt: `${prefix} please approve the pending run`,
    reason: "A run is waiting",
    sourceRefs: ["run:1"],
  },
  {
    kind: "follow_up" as const,
    label: `${prefix} follow up`,
    prompt: `${prefix} draft the follow-up`,
    reason: "Left open on Monday",
    sourceRefs: ["episode:1"],
  },
];

const write = async (userId: string, prefix: string, hash = "hash-1") =>
  replaceSuggestionBatch({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId,
    inputHash: hash,
    modelKey: "gpt-oss-120b",
    items: items(prefix),
  });

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

beforeEach(async () => {
  await db.delete(chatSuggestions).where(eq(chatSuggestions.teamId, fx.teamId));
});

afterAll(async () => {
  await fx.cleanup();
});

describe("chat suggestion batches", () => {
  test("a new batch supersedes the previous one, leaving one generation active", async () => {
    const [userA] = fx.userIds;

    const first = await write(userA, "first");
    const second = await write(userA, "second", "hash-2");

    const active = await getActiveSuggestionBatch({
      userId: userA,
      teamId: fx.teamId,
    });
    expect(active?.batchId).toBe(second.batchId);
    expect(active?.inputHash).toBe("hash-2");
    expect(active?.items.map((item) => item.label)).toEqual(
      items("second").map((item) => item.label),
    );

    const superseded = await db.query.chatSuggestions.findMany({
      where: { batchId: first.batchId },
    });
    expect(superseded).toHaveLength(2);
    expect(superseded.every((row) => row.status === "superseded")).toBe(true);
    expect(superseded.every((row) => row.resolvedAt !== null)).toBe(true);
  });

  test("one member's batch is invisible to the other", async () => {
    const [userA, userB] = fx.userIds;

    await write(userA, "mine");

    expect(
      await getActiveSuggestionBatch({ userId: userB, teamId: fx.teamId }),
    ).toBeNull();
  });

  test("a member cannot resolve a suggestion that is not theirs", async () => {
    const [userA, userB] = fx.userIds;

    const batch = await write(userA, "mine");
    const target = batch.items[0];
    expect(target).toBeDefined();

    const err = await rejection(
      markChatSuggestion({
        id: target?.id ?? "",
        userId: userB,
        teamId: fx.teamId,
        status: "dismissed",
      }),
    );
    expect(err.message).toContain("Suggestion");

    // And the row is untouched — a refusal that still wrote would be worse
    // than one that threw nothing.
    const row = await db.query.chatSuggestions.findFirst({
      where: { id: target?.id ?? "" },
    });
    expect(row?.status).toBe("active");
  });

  test("dismissing is idempotent — a second click cannot rewrite the verdict", async () => {
    const [userA] = fx.userIds;

    const batch = await write(userA, "mine");
    const id = batch.items[0]?.id ?? "";

    await markChatSuggestion({
      id,
      userId: userA,
      teamId: fx.teamId,
      status: "dismissed",
    });
    const err = await rejection(
      markChatSuggestion({
        id,
        userId: userA,
        teamId: fx.teamId,
        status: "used",
      }),
    );
    expect(err.message).toContain("Suggestion");

    const row = await db.query.chatSuggestions.findFirst({ where: { id } });
    expect(row?.status).toBe("dismissed");
  });

  test("a resolved suggestion leaves the active batch", async () => {
    const [userA] = fx.userIds;

    const batch = await write(userA, "mine");
    await markChatSuggestion({
      id: batch.items[0]?.id ?? "",
      userId: userA,
      teamId: fx.teamId,
      status: "used",
    });

    const active = await getActiveSuggestionBatch({
      userId: userA,
      teamId: fx.teamId,
    });
    expect(active?.items).toHaveLength(1);
  });
});

describe("anti-repetition feed", () => {
  test("lists what this reader accepted or rejected, and nobody else's", async () => {
    const [userA, userB] = fx.userIds;

    const mine = await write(userA, "mine");
    const theirs = await write(userB, "theirs");

    await markChatSuggestion({
      id: mine.items[0]?.id ?? "",
      userId: userA,
      teamId: fx.teamId,
      status: "dismissed",
    });
    await markChatSuggestion({
      id: theirs.items[0]?.id ?? "",
      userId: userB,
      teamId: fx.teamId,
      status: "dismissed",
    });

    const labels = await listRecentSuggestionLabels({
      userId: userA,
      teamId: fx.teamId,
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]?.label).toContain("mine");
    expect(labels[0]?.status).toBe("dismissed");
  });

  test("forgets a verdict older than the window", async () => {
    const [userA] = fx.userIds;

    const batch = await write(userA, "mine");
    const id = batch.items[0]?.id ?? "";
    await markChatSuggestion({
      id,
      userId: userA,
      teamId: fx.teamId,
      status: "dismissed",
    });
    await db
      .update(chatSuggestions)
      .set({ resolvedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) })
      .where(eq(chatSuggestions.id, id));

    expect(
      await listRecentSuggestionLabels({ userId: userA, teamId: fx.teamId }),
    ).toHaveLength(0);
  });

  test("says nothing about a batch that was merely superseded", async () => {
    // Nobody rejected those — the context moved on before anyone looked, and
    // suppressing them would erase a suggestion that was never seen.
    const [userA] = fx.userIds;

    await write(userA, "first");
    await write(userA, "second", "hash-2");

    expect(
      await listRecentSuggestionLabels({ userId: userA, teamId: fx.teamId }),
    ).toHaveLength(0);
  });
});
