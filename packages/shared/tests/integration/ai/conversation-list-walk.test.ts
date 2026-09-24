import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { aiConversationMembers, aiConversations } from "../../../src/db/schema";
import { listConversations } from "../../../src/services/ai/list";
import { setMemberPinned } from "../../../src/services/ai/members/set-pinned";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The keyset walk of the conversation list — `paginate: "cursor"` with
 * `pinned: false` — and the `pinned` split it depends on.
 *
 * The list moved into the main sidebar, where it is a permanent lane that only
 * scrolls forward, and offset paging over `updated_at DESC` cannot serve that:
 * every conversation bumped by a message shifts a row across a page boundary,
 * duplicating one and hiding another. `a bump mid-walk serves no row twice` is
 * that exact scenario and is the reason this file exists.
 *
 * Every predicate below was deleted from `listConversations` and the case named
 * beside it went red — that, and not the green run, is what says these test the
 * query:
 *  - the `(updated_at, id) < (…)` seek → `walks every row exactly once`,
 *    `a bump mid-walk serves no row twice`, `walks past a tie on updated_at`;
 *  - the `id` element INSIDE that seek → `walks past a tie on updated_at`,
 *    which otherwise re-serves the same row of the tied pair forever;
 *  - `pinned_at IS NULL` on the walk's membership → `excludes the caller's
 *    pins` and `the two blocks partition the list exactly`;
 *  - `pinned_at IS NOT NULL` on the pinned block → all three `pinned split`
 *    cases;
 *  - `ORDER BY pinned_at DESC` → `pinned:true returns … newest pin first`.
 * The one thing NO case here pins is `desc(id)` in the walk's ORDER BY: the
 * index supplies that order today, so deleting it stays green. It is written
 * out in the query anyway, and the comment there says why.
 *
 * The stale-cursor arm (`not exists …`) has its own two cases: a cursor is far
 * more often a tab left open across a deploy than a bug, and both must restart
 * the walk rather than end it silently or 500.
 */

let fx: WorkspaceFixture;
/** Seven conversations, newest first — the order the walk must reproduce. */
let ids: string[] = [];

const MINUTE_MS = 60 * 1000;

const seat = async (conversationId: string): Promise<void> => {
  await db.insert(aiConversationMembers).values(
    fx.userIds.map((userId, index) => ({
      conversationId,
      userId,
      role: index === 0 ? ("owner" as const) : ("member" as const),
    })),
  );
};

/**
 * `ids` is filled in `beforeAll`, so its element type stays `string |
 * undefined` under `noUncheckedIndexedAccess`. These two narrow it by FAILING
 * rather than by asserting: a cast would turn a broken fixture into a
 * confusing assertion further down, and the rest of this suite carries no
 * casts either.
 */
const conversationAt = (index: number): string => {
  const id = ids[index];
  if (!id) throw new Error(`no seeded conversation at index ${index}`);
  return id;
};

const cursorOf = (result: { nextCursor?: string | null }): string => {
  const { nextCursor } = result;
  if (!nextCursor) throw new Error("expected a nextCursor, got none");
  return nextCursor;
};

const walk = async (options: {
  limit: number;
  cursor?: string;
  userId?: string;
}) =>
  listConversations({
    scope: { teamId: fx.teamId },
    userId: options.userId ?? fx.userIds[0],
    agentType: "chatbot",
    params: { limit: options.limit, page: 0 },
    pinned: false,
    paginate: "cursor",
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });

/** Walk to exhaustion and return every id served, in order. */
const walkAll = async (limit: number): Promise<string[]> => {
  const served: string[] = [];
  let cursor: string | undefined;
  // Guard rather than `while (true)`: a broken seek loops forever, and a
  // hanging suite says far less than a failed assertion.
  for (let page = 0; page < 20; page++) {
    const result = await walk({ limit, ...(cursor ? { cursor } : {}) });
    served.push(...result.data.map((row) => row.id));
    if (!result.nextCursor) return served;
    cursor = result.nextCursor;
  }
  throw new Error("walk did not terminate within 20 pages");
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();

  // Spaced by a minute and inserted oldest-first, so the expected order is the
  // reverse of the insertion order and no two rows can tie by accident.
  const created: string[] = [];
  for (let index = 6; index >= 0; index--) {
    const row = await fx.createConversation({
      title: `Walk ${index.toString()}`,
      updatedAt: new Date(Date.now() - index * MINUTE_MS),
    });
    await seat(row.id);
    created.push(row.id);
  }
  ids = created;
});

/**
 * `randomize = true` is on in `bunfig.toml`: a case that inherited the pin or
 * the timestamp another one left behind would pass or fail by seed.
 */
beforeEach(async () => {
  await db
    .update(aiConversationMembers)
    .set({ pinnedAt: null })
    .where(inArray(aiConversationMembers.conversationId, ids));
  for (const [index, id] of ids.entries()) {
    await db
      .update(aiConversations)
      .set({ updatedAt: new Date(Date.now() - index * MINUTE_MS) })
      .where(eq(aiConversations.id, id));
  }
});

afterAll(async () => {
  await fx.cleanup();
});

describe("conversation list — keyset walk", () => {
  test("walks every row exactly once, in activity order", async () => {
    const served = await walkAll(3);

    expect(served).toEqual(ids);
    expect(new Set(served).size).toBe(served.length);
  });

  test("the last page reports nextCursor null, earlier ones do not", async () => {
    const first = await walk({ limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).toBe(first.data[2]?.id);

    const last = await walk({ limit: 50 });
    expect(last.data).toHaveLength(ids.length);
    expect(last.nextCursor).toBeNull();
  });

  test("a bump mid-walk serves no row twice", async () => {
    const first = await walk({ limit: 3 });
    const cursor = cursorOf(first);

    // A conversation still ahead of the cursor receives a message: it jumps to
    // the top of the list, ABOVE the region the walk has yet to read. Under
    // offset paging it would slide into the page just served and come back a
    // second time.
    const bumped = conversationAt(5);
    await db
      .update(aiConversations)
      .set({ updatedAt: new Date() })
      .where(eq(aiConversations.id, bumped));

    const second = await walk({ limit: 3, cursor });
    const served = [...first.data, ...second.data].map((row) => row.id);

    expect(new Set(served).size).toBe(served.length);
    expect(second.data.map((row) => row.id)).not.toContain(first.data[0]?.id);
  });

  test("walks past a tie on updated_at", async () => {
    // To the microsecond: the ORDER BY and the seek must agree on a second key
    // or this pair traps the walk.
    const tied = new Date(Date.now() - 30 * MINUTE_MS);
    const [first, second] = [conversationAt(1), conversationAt(2)];
    await db
      .update(aiConversations)
      .set({ updatedAt: tied })
      .where(inArray(aiConversations.id, [first, second]));

    const served = await walkAll(1);

    expect(served).toContain(first);
    expect(served).toContain(second);
    expect(new Set(served).size).toBe(served.length);
    expect(served).toHaveLength(ids.length);
  });

  test("excludes the caller's pins, and only the caller's", async () => {
    const [userA, userB] = fx.userIds;
    const pinned = conversationAt(4);
    await setMemberPinned({
      conversationId: pinned,
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });

    const mine = await walkAll(50);
    expect(mine).not.toContain(pinned);
    expect(mine).toHaveLength(ids.length - 1);

    // The pin is per member: the other participant's stream is untouched.
    const theirs = await walk({ limit: 50, userId: userB });
    expect(theirs.data.map((row) => row.id)).toContain(pinned);
  });

  test("a cursor whose conversation is gone restarts the walk", async () => {
    const first = await walk({ limit: 3 });
    const cursor = cursorOf(first);

    // Not the fixture's rows — a conversation that never existed reads exactly
    // like one deleted between two pages.
    const restarted = await walk({ limit: 3, cursor: randomUUID() });

    expect(restarted.data.map((row) => row.id)).toEqual(
      first.data.map((row) => row.id),
    );
    expect(restarted.nextCursor).toBe(cursor);
  });

  test("a cursor that is not an id restarts the walk instead of erroring", async () => {
    const first = await walk({ limit: 3 });

    const restarted = await walk({ limit: 3, cursor: "not-a-cursor" });

    expect(restarted.data.map((row) => row.id)).toEqual(
      first.data.map((row) => row.id),
    );
  });

  test("the walk skips the count; the offset path still returns the total", async () => {
    const walked = await walk({ limit: 3 });
    expect(walked.count).toBe(0);

    const paged = await listConversations({
      scope: { teamId: fx.teamId },
      userId: fx.userIds[0],
      agentType: "chatbot",
      params: { limit: 3, page: 0 },
    });
    expect(paged.count).toBe(ids.length);
    expect(paged.data).toHaveLength(3);
    expect(paged.nextCursor).toBeUndefined();
  });
});

describe("conversation list — pinned split", () => {
  test("pinned:true returns only the caller's pins, newest pin first", async () => {
    const userA = fx.userIds[0];
    const firstPinned = conversationAt(5);
    const secondPinned = conversationAt(1);

    await setMemberPinned({
      conversationId: firstPinned,
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });
    await setMemberPinned({
      conversationId: secondPinned,
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });

    const pinnedList = await listConversations({
      scope: { teamId: fx.teamId },
      userId: userA,
      agentType: "chatbot",
      params: { limit: 25, page: 0 },
      pinned: true,
    });

    // Newest PIN first, not newest activity — `firstPinned` is the more
    // recently active of the two and must still come second.
    expect(pinnedList.data.map((row) => row.id)).toEqual([
      secondPinned,
      firstPinned,
    ]);
    expect(pinnedList.data.every((row) => row.pinned)).toBe(true);
    expect(pinnedList.count).toBe(2);
  });

  test("pinned:true is empty for a member who pinned nothing", async () => {
    const [userA, userB] = fx.userIds;
    await setMemberPinned({
      conversationId: conversationAt(0),
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });

    const theirs = await listConversations({
      scope: { teamId: fx.teamId },
      userId: userB,
      agentType: "chatbot",
      params: { limit: 25, page: 0 },
      pinned: true,
    });

    expect(theirs.data).toEqual([]);
    expect(theirs.count).toBe(0);
  });

  test("the two blocks partition the list exactly", async () => {
    const userA = fx.userIds[0];
    await setMemberPinned({
      conversationId: conversationAt(3),
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });

    const pinnedList = await listConversations({
      scope: { teamId: fx.teamId },
      userId: userA,
      agentType: "chatbot",
      params: { limit: 25, page: 0 },
      pinned: true,
    });
    const rest = await walkAll(50);

    expect([...pinnedList.data.map((row) => row.id), ...rest].sort()).toEqual(
      [...ids].sort(),
    );
  });

  test("search narrows the pinned block too", async () => {
    const userA = fx.userIds[0];
    await setMemberPinned({
      conversationId: conversationAt(0),
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });
    await setMemberPinned({
      conversationId: conversationAt(1),
      teamId: fx.teamId,
      userId: userA,
      pinned: true,
    });

    // "Walk 6" is the newest (index 6 was inserted with the smallest offset).
    const found = await listConversations({
      scope: { teamId: fx.teamId },
      userId: userA,
      agentType: "chatbot",
      params: { limit: 25, page: 0, search: "Walk 6" },
      pinned: true,
    });

    expect(found.data.map((row) => row.id)).toEqual([conversationAt(0)]);
  });
});
