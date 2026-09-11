import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { aiEpisodes } from "../../../src/db/schema";
import { listStandingEpisodes } from "../../../src/services/episodes/list-standing";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * What is allowed into the standing block.
 *
 * Integration, because every claim here IS a `WHERE` clause and the house rule
 * applies: if an assertion still holds after its predicate is deleted, it is
 * not testing the query. Each test seeds a row that matches everything EXCEPT
 * the clause under test.
 *
 * The privacy pair carries the weight. This block is rendered into every turn
 * and, unlike the retrieved block, nothing upstream of it filtered on the
 * message — a row that reaches it reaches the reader unconditionally. The two
 * halves are one test on purpose: the exclusion alone is satisfiable by a
 * function that returns nothing at all.
 */

let ws: WorkspaceFixture;

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const seedEpisode = async (values: {
  title: string;
  kind: "conversation" | "record_activity" | "consolidated";
  userId?: string;
  occurredTo?: Date;
  state?: "active" | "demoted" | "superseded";
}): Promise<void> => {
  await db.insert(aiEpisodes).values({
    organizationId: ws.organizationId,
    teamId: ws.teamId,
    userId: values.userId ?? null,
    kind: values.kind,
    state: values.state ?? "active",
    title: values.title,
    summary: `summary of ${values.title}`,
    occurredTo: values.occurredTo ?? daysAgo(1),
    contentHash: values.title,
  });
};

const titlesFor = async (userId: string): Promise<string[]> => {
  const { items } = await listStandingEpisodes({
    organizationId: ws.organizationId,
    teamId: ws.teamId,
    userId,
  });
  return items.map((i) => i.title);
};

// A workspace PER TEST, not per file. The block's caps are global (10
// decisions, 3 activity rows), so rows one test seeds evict another's — and
// bun randomises test order by seed, so a shared fixture makes this file pass
// or fail depending on the seed. It passed three runs before the seed that
// ordered `caps` first, whose six fresh activity rows pushed the window test's
// row past `MAX_ACTIVITY`.
beforeEach(async () => {
  ws = await createWorkspaceFixture();
});

afterEach(async () => {
  await ws.cleanup();
});

describe("scope", () => {
  test("carries the reader's OWN private episodes and no one else's", async () => {
    // The reason this block is rendered per reader instead of generated per
    // team: `distillConversation` writes a PRIVATE episode when a conversation
    // has one participant, so on a solo team everything the pipeline produces
    // is user-scoped. A team-scoped artefact sees none of it.
    const [me, other] = ws.userIds;
    await seedEpisode({ kind: "conversation", title: "mine", userId: me });
    await seedEpisode({ kind: "conversation", title: "theirs", userId: other });
    await seedEpisode({ kind: "conversation", title: "ours" });

    const mine = await titlesFor(me);
    expect(mine).toContain("mine");
    expect(mine).toContain("ours");
    expect(mine).not.toContain("theirs");

    // And symmetrically, or the exclusion above could be a function that
    // returns nothing.
    const theirs = await titlesFor(other);
    expect(theirs).toContain("theirs");
    expect(theirs).not.toContain("mine");
  });
});

describe("window and state", () => {
  test("a superseded episode is out, its survivor is in", async () => {
    // Consolidation supersedes rather than deletes, so without this clause the
    // block would state a value the team has already corrected — next to the
    // correction.
    const [me] = ws.userIds;
    await seedEpisode({
      kind: "consolidated",
      title: "old lead time",
      state: "superseded",
    });
    await seedEpisode({ kind: "consolidated", title: "new lead time" });

    const titles = await titlesFor(me);
    expect(titles).toContain("new lead time");
    expect(titles).not.toContain("old lead time");
  });

  test("31 days old is out, 29 is in", async () => {
    const [me] = ws.userIds;
    await seedEpisode({
      kind: "conversation",
      title: "last month",
      occurredTo: daysAgo(31),
    });
    await seedEpisode({
      kind: "conversation",
      title: "this month",
      occurredTo: daysAgo(29),
    });

    const titles = await titlesFor(me);
    expect(titles).toContain("this month");
    expect(titles).not.toContain("last month");
  });

  test("record_activity has its own, tighter window", async () => {
    // These are ROLLING digests rebuilt weekly, so one older than its own
    // rebuild cycle has already been replaced by a newer one.
    const [me] = ws.userIds;
    await seedEpisode({
      kind: "record_activity",
      title: "activity last week",
      occurredTo: daysAgo(10),
    });
    await seedEpisode({
      kind: "record_activity",
      title: "activity this week",
      occurredTo: daysAgo(2),
    });

    const titles = await titlesFor(me);
    expect(titles).toContain("activity this week");
    expect(titles).not.toContain("activity last week");
  });
});

describe("caps", () => {
  test("activity is capped separately, so it cannot crowd out decisions", async () => {
    // One budget for both would let a busy record's rolling digests fill the
    // block on a week the team also took decisions. The caps are per kind for
    // that reason, and `visibleInWindow` reports what was left out.
    const [me] = ws.userIds;
    for (let i = 0; i < 6; i++) {
      await seedEpisode({
        kind: "record_activity",
        title: `activity ${i.toString()}`,
        occurredTo: daysAgo(1),
      });
    }
    await seedEpisode({
      kind: "conversation",
      title: "a decision among the noise",
      occurredTo: daysAgo(3),
    });

    const { items, visibleInWindow } = await listStandingEpisodes({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      userId: me,
    });
    const activity = items.filter((i) => i.kind === "record_activity");
    expect(activity).toHaveLength(3);
    expect(items.map((i) => i.title)).toContain("a decision among the noise");
    // Everything in the window, including what the caps dropped — the renderer
    // points at `searchKnowledge` with it rather than pretending the block is
    // the whole story.
    expect(visibleInWindow).toBeGreaterThan(items.length);
  });

  test("the count survives a selection the caps emptied", async () => {
    // The count is JOINED onto the rows, not read off the first one. Read off
    // the rows it would be 0 exactly when every episode in the window falls
    // outside the caps — and the renderer turns a 0 into "nothing recorded in
    // the last few weeks", which the agent then tells the user. A block that
    // says nothing is worse than a block that says "3 more, go look".
    const [me] = ws.userIds;
    if (me === undefined) throw new Error("fixture has no user");
    for (let i = 0; i < 3; i++) {
      // In the 30-day window, but older than the 7-day activity window — so
      // visible, and selected by neither branch.
      await seedEpisode({
        kind: "record_activity",
        title: `stale activity ${i.toString()}`,
        occurredTo: daysAgo(12),
      });
    }
    const { items, visibleInWindow } = await listStandingEpisodes({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      userId: me,
    });
    expect(items).toHaveLength(0);
    expect(visibleInWindow).toBe(3);
  });
});
