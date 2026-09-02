import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import type { BulkOperation } from "../../../src/db/schema";
import {
  bulkOperationChunks,
  bulkOperations,
  conversationBackgroundTasks,
} from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Picking a failed import back up.
 *
 * A staged load is the one write here that can be half-done: chunks are
 * applied one transaction at a time and stamped, so the rest can be drained
 * later. That was built and then unreachable — a failed operation kept its
 * ledger "for a re-queue" nothing exposed, and both entry points answered every
 * re-run of the identical code with "a previous attempt at this exact load
 * ended as failed". The user's half-imported table had no way forward except a
 * different file, which is exactly the workaround the 2026-08-28 incident was
 * already forced into for another reason.
 *
 * Integration: every claim below is a state transition guarded by a WHERE
 * (`failed` → `queued` once, `failed` task → `pending`, unapplied chunks only).
 * A doubled database would be asserting its own bookkeeping.
 *
 * The queue is the one double — enqueueing is the side effect being observed,
 * not a data source, and a real BullMQ would need a worker to prove anything.
 */

let fx: WorkspaceFixture;
let conversationId: string;
/** Operation ids handed to the queue, in order. */
let enqueued: string[];

await mockModule("../../src/services/bulk-operations/queue", {
  enqueueBulkOperation: async (id: string) => {
    enqueued.push(id);
  },
});

const { resumeBulkOperation, MAX_BULK_OPERATION_RESUMES } =
  await import("../../../src/services/bulk-operations/resume");

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

beforeEach(async () => {
  conversationId = (await fx.createConversation()).id;
  enqueued = [];
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;

/**
 * A failed load of two chunks: the first applied, the second never was — the
 * shape a drain that died halfway leaves behind.
 */
const failedOperation = async (
  over: {
    resumeCount?: number;
    appliedChunks?: number;
    status?: BulkOperation["status"];
  } = {},
): Promise<BulkOperation> => {
  const collection = await fx.createCollection();
  const [operation] = await db
    .insert(bulkOperations)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId,
      turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
      kind: "record_import",
      mode: "staged",
      status: over.status ?? "failed",
      lookupHash: `import-hash-${(seq++).toString()}`,
      totalItems: 4,
      chunkSize: 2,
      params: {
        op: "create",
        collectionId: collection.id,
        collectionKey: collection.key,
      },
      sample: [{ name: "row" }],
      error: "The import stopped after 3 attempts: connection terminated",
      resumeCount: over.resumeCount ?? 0,
      finishedAt: new Date(),
    })
    .returning();
  if (!operation) throw new Error("failed to insert operation");

  const applied = over.appliedChunks ?? 1;
  await db.insert(bulkOperationChunks).values(
    [0, 1].map((chunkIndex) => ({
      operationId: operation.id,
      chunkIndex,
      itemCount: 2,
      items: [{ name: `chunk ${chunkIndex.toString()}` }],
      ...(chunkIndex < applied ? { appliedAt: new Date() } : {}),
    })),
  );

  // The conversation was told this load failed — the state a resume has to
  // undo, or nobody is woken when it finishes the second time.
  await db.insert(conversationBackgroundTasks).values({
    conversationId,
    kind: "bulk_operation",
    ref: operation.id,
    title: "Import",
    status: "failed",
    completedAt: new Date(),
    consumedAt: new Date(),
  });

  return operation;
};

const reload = async (id: string): Promise<BulkOperation | undefined> =>
  db.query.bulkOperations.findFirst({ where: { id } });

const taskOf = async (ref: string) =>
  db.query.conversationBackgroundTasks.findFirst({
    where: { kind: "bulk_operation", ref },
  });

describe("a failed load is picked back up, not refused", () => {
  test("re-queues it and counts the attempt", async () => {
    const operation = await failedOperation();

    const outcome = await resumeBulkOperation(operation);

    expect(outcome.state).toBe("resumed");
    const after = await reload(operation.id);
    expect(after?.status).toBe("queued");
    // The reason is cleared: it described the attempt that is now superseded,
    // and leaving it would report a live load as failed.
    expect(after?.error).toBeNull();
    expect(after?.finishedAt).toBeNull();
    expect(after?.resumeCount).toBe(1);
    expect(enqueued).toEqual([operation.id]);
  });

  test("only the chunks that never landed are left to drain", async () => {
    // The whole basis of resuming: the applied chunk keeps its stamp, so the
    // drain cannot write its rows a second time.
    const operation = await failedOperation({ appliedChunks: 1 });

    const outcome = await resumeBulkOperation(operation);

    expect(outcome).toMatchObject({ state: "resumed", remainingChunks: 1 });
    const stillPending = await db
      .select()
      .from(bulkOperationChunks)
      .where(
        and(
          eq(bulkOperationChunks.operationId, operation.id),
          eq(bulkOperationChunks.chunkIndex, 0),
        ),
      );
    expect(stillPending[0]?.appliedAt).not.toBeNull();
  });

  test("the conversation waits on it again", async () => {
    const operation = await failedOperation();

    await resumeBulkOperation(operation);

    const task = await taskOf(operation.id);
    expect(task?.status).toBe("pending");
    expect(task?.completedAt).toBeNull();
    // Cleared too: a consumed row is one whose outcome a turn already read,
    // and that outcome is now stale — left stamped, the new one is unclaimable.
    expect(task?.consumedAt).toBeNull();
  });

  test("two racing resumes drain it once", async () => {
    const operation = await failedOperation();

    const [a, b] = await Promise.all([
      resumeBulkOperation(operation),
      resumeBulkOperation(operation),
    ]);

    const resumedCount = [a, b].filter((r) => r.state === "resumed").length;
    expect(resumedCount).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect((await reload(operation.id))?.resumeCount).toBe(1);
  });
});

describe("what resuming refuses to do", () => {
  test("stops repeating once the same failure has come back enough times", async () => {
    // BullMQ already retried the failing chunk several times before the load
    // was marked failed, so a cause that survives this many resumes is not
    // going to clear on the next one.
    const operation = await failedOperation({
      resumeCount: MAX_BULK_OPERATION_RESUMES,
    });

    const outcome = await resumeBulkOperation(operation);

    expect(outcome.state).toBe("refused");
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("connection terminated"),
    );
    // And it says what to do instead of "retry", which is what the caller
    // would otherwise keep doing.
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("change the rows"),
    );
    expect(await reload(operation.id)).toMatchObject({ status: "failed" });
    expect(enqueued).toEqual([]);
  });

  test("reports a load whose chunks all landed instead of re-queueing it", async () => {
    const operation = await failedOperation({ appliedChunks: 2 });

    const outcome = await resumeBulkOperation(operation);

    expect(outcome.state).toBe("nothing_left");
    expect(enqueued).toEqual([]);
  });

  test("never resumes a cancelled load, and says why", async () => {
    // Cancelled means the user refused it. Re-running is asking again, not
    // recovering, and it must not happen behind their back.
    //
    // Asserting the SENTENCE, not just the refusal: the UPDATE's own
    // `status = 'failed'` predicate would refuse this anyway, but as "already
    // picked up by another attempt" — true of nothing, and it would hide the
    // loss of the check above.
    const operation = await failedOperation({ status: "cancelled" });

    const outcome = await resumeBulkOperation(operation);

    expect(outcome).toMatchObject({
      state: "refused",
      reason: "This load is cancelled; only a failed one can be resumed.",
    });
    expect(await reload(operation.id)).toMatchObject({ status: "cancelled" });
    expect(enqueued).toEqual([]);
  });
});
