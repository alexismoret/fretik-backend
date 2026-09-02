import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import {
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../src/db/schema";
import {
  claimGrantedApproval,
  markFailedApproval,
} from "../../../src/services/approvals/claim";
import { findLatestApprovalByHash } from "../../../src/services/approvals/find";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * What happens to the NEXT identical write after one has gone wrong.
 *
 * The incident (prod, 2026-08-28): a bulk import of 666 rows was approved, threw
 * in Postgres, and left its row `executing` with nobody on it. `executing` is a
 * state the machine deliberately refuses to re-execute AND one the hash lookup
 * still returns — so every retry was answered "currently executing" and no card
 * was ever shown again. The agent, told to "check state before retrying",
 * retried seven times into the same dead end; the same rows only imported once
 * they were split into batches, which changed the hash.
 *
 * Integration, not unit, and the reason is the whole point: every property here
 * lives in a WHERE clause. A fake `findFirst` would answer whatever the fake
 * decided about `status`, so the assertions would hold with the status filter
 * deleted from the service — the one thing they exist to prove.
 *
 * The gate's own routing over these states is exercised in
 * `gate-retry.test.ts`, which drives the same rows through `runApprovalGate`.
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

let seq = 0;
/** A row of its own hash, so suites and cases never collide on the lookup. */
const insertApproval = async (
  status: ToolApprovalRequest["status"],
  over: Partial<typeof toolApprovalRequests.$inferInsert> = {},
): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId,
      turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
      kind: "record_write",
      lookupHash: `hash-${(seq++).toString()}`,
      status,
      ...over,
    })
    .returning();
  if (!row) throw new Error("failed to insert approval");
  return row;
};

const statusOf = async (id: string): Promise<string> => {
  const row = await db.query.toolApprovalRequests.findFirst({
    where: { id },
  });
  return row?.status ?? "<gone>";
};

describe("findLatestApprovalByHash — which rows can still answer for a hash", () => {
  test.each([
    ["pending", true],
    ["granted", true],
    ["executing", true],
    ["consumed", true],
    ["rejected", false],
    ["failed", false],
  ] as const)("%s row is %p to the lookup", async (status, visible) => {
    const row = await insertApproval(status);

    const found = await findLatestApprovalByHash({
      conversationId,
      lookupHash: row.lookupHash ?? "",
    });

    // The two terminal states a retry may move past are exactly the two the
    // lookup must not return: otherwise a refused — or a failed — operation
    // answers for every later attempt at it and can never be proposed again.
    expect(found?.id ?? null).toBe(visible ? row.id : null);
  });

  test("a later failure does not erase the cached success of the same write", async () => {
    // The rows are ordered newest-first, so a dead row created LAST is the one
    // the lookup would otherwise return — and returning it here would be a
    // double write: the gate would stop replaying the consumed result and let
    // the very same rows be granted a second time.
    const hash = "consumed-then-failed";
    const done = await insertApproval("consumed", {
      lookupHash: hash,
      result: [],
    });
    const dead = await insertApproval("failed", {
      lookupHash: hash,
      executionError: 'cannot insert a non-DEFAULT value into column "total"',
    });

    const found = await findLatestApprovalByHash({
      conversationId,
      lookupHash: hash,
    });

    expect(found?.id).toBe(done.id);
    expect(found?.id).not.toBe(dead.id);
  });

  test("another conversation's row never answers for this one", async () => {
    // `lookupHash` is content-derived, so two conversations importing the same
    // file share it — the conversation is the only thing keeping them apart.
    const hash = "shared-across-conversations";
    await insertApproval("pending", { lookupHash: hash });
    const otherConversation = (await fx.createConversation()).id;

    const found = await findLatestApprovalByHash({
      conversationId: otherConversation,
      lookupHash: hash,
    });

    expect(found).toBeUndefined();
  });
});

describe("markFailedApproval — closing a claim that will never finish", () => {
  test("moves an executing row to failed and keeps the reason", async () => {
    const row = await insertApproval("executing", { executedAt: new Date() });

    const failed = await markFailedApproval(row.id, "Postgres said no");

    expect(failed?.status).toBe("failed");
    expect(failed?.executionError).toBe("Postgres said no");
    expect(await statusOf(row.id)).toBe("failed");
  });

  test("leaves a partial result in place", async () => {
    // A plan that failed halfway wrote per-op results as it went; the reason
    // goes in its own column precisely so those survive.
    const partial = [{ ok: true as const, data: { id: 1 } }];
    const row = await insertApproval("executing", {
      executedAt: new Date(),
      result: partial,
    });

    await markFailedApproval(row.id, "connection lost");

    const after = await db.query.toolApprovalRequests.findFirst({
      where: { id: row.id },
    });
    expect(after?.result).toEqual(partial);
    expect(after?.executionError).toBe("connection lost");
  });

  test.each(["pending", "granted", "consumed", "rejected"] as const)(
    "refuses to fail a %s row",
    async (status) => {
      // Only a CLAIMED row may be failed. Without the status predicate a late
      // error handler could bury a consumed write — or a pending one the user
      // has not even seen — under a failure it had nothing to do with.
      const row = await insertApproval(status);

      const failed = await markFailedApproval(row.id, "should not apply");

      expect(failed).toBeUndefined();
      expect(await statusOf(row.id)).toBe(status);
    },
  );

  test("only one of two concurrent closers wins the row", async () => {
    const row = await insertApproval("executing", { executedAt: new Date() });

    const [a, b] = await Promise.all([
      markFailedApproval(row.id, "first"),
      markFailedApproval(row.id, "second"),
    ]);

    expect([a, b].filter((r) => r !== undefined)).toHaveLength(1);
    expect(await statusOf(row.id)).toBe("failed");
  });
});

describe("claimGrantedApproval — the claim it pairs with", () => {
  test("claims a granted row exactly once", async () => {
    const row = await insertApproval("granted");

    const [first, second] = await Promise.all([
      claimGrantedApproval(row.id),
      claimGrantedApproval(row.id),
    ]);

    expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
    expect(await statusOf(row.id)).toBe("executing");
  });

  test("a failed row is never re-claimable", async () => {
    // Terminal means terminal: recovery is a NEW request (the lookup skips
    // this one), never a second grant of the write that already went wrong.
    const row = await insertApproval("executing", { executedAt: new Date() });
    await markFailedApproval(row.id, "boom");

    expect(await claimGrantedApproval(row.id)).toBeUndefined();
    expect(await statusOf(row.id)).toBe("failed");
  });
});

describe("the enum accepts the new state", () => {
  test("failed survives a round trip through Postgres", async () => {
    // The migration adds a VALUE to a pg enum; a missing one fails at INSERT,
    // and only against a real database.
    const row = await insertApproval("failed");
    await db
      .update(toolApprovalRequests)
      .set({ status: "failed" })
      .where(eq(toolApprovalRequests.id, row.id));

    expect(await statusOf(row.id)).toBe("failed");
  });
});
