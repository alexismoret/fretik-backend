import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";
import db from "../../../src/db";
import { aiConversationMembers } from "../../../src/db/schema";
import { listConversations } from "../../../src/services/ai/list";
import { setMemberPinned } from "../../../src/services/ai/members/set-pinned";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Pinning a conversation, which is two claims in the SQL and nothing in the
 * TypeScript:
 *
 *  1. **The pin decides the ORDER, server-side.** The list is paginated, so a
 *     client-side sort would only float the pins that happen to be on the page
 *     it already holds. Every case below pins the OLDER conversation, so an
 *     `ORDER BY` that lost its `pinned_at` term answers with the newer one and
 *     the assertion fails — which is the only reason these fixtures bother to
 *     set `updatedAt` by hand.
 *  2. **The pin is PER MEMBER.** A conversation is shared; the same two rows
 *     are read by both users here, and the second user's list must not move
 *     when the first one pins. Deleting the `user_id` predicate from the
 *     ordering subquery reddens `does not reorder the other member's list`.
 */

let fx: WorkspaceFixture;
let older: { id: string };
let newer: { id: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const listFor = async (userId: string) =>
  listConversations({
    teamId: fx.teamId,
    userId,
    agentType: "chatbot",
    params: { limit: 20, page: 0 },
  });

const idsFor = async (userId: string): Promise<string[]> =>
  (await listFor(userId)).data.map((row) => row.id);

const pin = async (conversationId: string, userId: string, pinned: boolean) =>
  setMemberPinned({ conversationId, teamId: fx.teamId, userId, pinned });

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  const [userA, userB] = fx.userIds;

  older = await fx.createConversation({
    title: "Older conversation",
    updatedAt: new Date(Date.now() - 3 * DAY_MS),
  });
  newer = await fx.createConversation({
    title: "Newer conversation",
    updatedAt: new Date(Date.now() - 1 * DAY_MS),
  });

  // Both users participate in both conversations — the shape that makes
  // "per member" testable at all.
  await db.insert(aiConversationMembers).values([
    { conversationId: older.id, userId: userA, role: "owner" },
    { conversationId: older.id, userId: userB, role: "member" },
    { conversationId: newer.id, userId: userA, role: "owner" },
    { conversationId: newer.id, userId: userB, role: "member" },
  ]);
});

/**
 * `randomize = true` is on in `bunfig.toml`, so a test that inherits the pin
 * another one left behind passes or fails by seed. Each case sets up the state
 * it asserts on; this only guarantees the slate it starts from.
 */
beforeEach(async () => {
  await db
    .update(aiConversationMembers)
    .set({ pinnedAt: null })
    .where(inArray(aiConversationMembers.conversationId, [older.id, newer.id]));
});

afterAll(async () => {
  await fx.cleanup();
});

describe("conversation pins", () => {
  test("unpinned, both members see most-recently-active first", async () => {
    const [userA, userB] = fx.userIds;

    expect(await idsFor(userA)).toEqual([newer.id, older.id]);
    expect(await idsFor(userB)).toEqual([newer.id, older.id]);

    const list = await listFor(userA);
    expect(list.data.every((row) => !row.pinned)).toBe(true);
    expect(list.data.every((row) => row.pinnedAt === null)).toBe(true);
  });

  test("a pinned conversation leads the list even when it is the oldest", async () => {
    const [userA] = fx.userIds;

    await pin(older.id, userA, true);

    const list = await listFor(userA);
    expect(list.data.map((row) => row.id)).toEqual([older.id, newer.id]);
    expect(list.data[0]?.pinned).toBe(true);
    expect(list.data[0]?.pinnedAt).toBeInstanceOf(Date);
    expect(list.data[1]?.pinned).toBe(false);
  });

  test("does not reorder the other member's list", async () => {
    const [userA, userB] = fx.userIds;

    await pin(older.id, userA, true);

    const list = await listFor(userB);
    expect(list.data.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(list.data.every((row) => !row.pinned)).toBe(true);
  });

  test("re-pinning keeps the original position instead of restamping it", async () => {
    const [userA] = fx.userIds;

    await pin(older.id, userA, true);
    const before = (await listFor(userA)).data[0]?.pinnedAt;
    expect(before).toBeInstanceOf(Date);

    await pin(older.id, userA, true);

    const after = (await listFor(userA)).data[0]?.pinnedAt;
    expect(after).toEqual(before as Date);
  });

  test("unpinning restores the activity order", async () => {
    const [userA] = fx.userIds;

    await pin(older.id, userA, true);
    expect((await idsFor(userA))[0]).toBe(older.id);

    await pin(older.id, userA, false);

    const list = await listFor(userA);
    expect(list.data.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(list.data.every((row) => !row.pinned)).toBe(true);
  });

  test("a conversation the caller is not a member of answers 404", async () => {
    const outsider = await createWorkspaceFixture();
    try {
      // Same team, so only the MEMBERSHIP can refuse this — the team predicate
      // would let it through.
      const stranger = await fx.createConversation({ title: "Not yours" });
      const err = await rejection(
        setMemberPinned({
          conversationId: stranger.id,
          teamId: fx.teamId,
          userId: outsider.userIds[0],
          pinned: true,
        }),
      );
      expect(err.message).toContain("Conversation");
    } finally {
      await outsider.cleanup();
    }
  });
});
