import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import type { BulkOperation, BulkOperationKind } from "../../../src/db/schema";
import { bulkOperationChunks, bulkOperations } from "../../../src/db/schema";
import { bulkCreateCollectionRecords } from "../../../src/services/collection-records/bulk-create";
import { createCollectionWithFields } from "../../../src/services/collections/create-with-fields";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * What a streamed UPDATE or DELETE has to get right that a streamed create did
 * not have to.
 *
 * Three claims, each of which destroys or loses data when it is false:
 *
 *  1. **One chunk is one transaction.** The ledger stamps a chunk applied or
 *     not at all, and the whole exactly-once design rests on those two states
 *     meaning what they say. `bulkDeleteCollectionRecords` splits its own work
 *     at `DB_BULK_CHUNK_SIZE` (500) and, left alone, commits each split — so a
 *     2 000-id chunk that fails on its third split is REPORTED as failed with
 *     1 000 rows already gone, and re-running it deletes rows it was told it
 *     had not deleted.
 *  2. **The collection is a filter.** A load names its target before its rows
 *     arrive: that target sized the chunks and is what the approval card said.
 *     An id from another collection has to be refused, not written.
 *  3. **A load with no conversation finishes.** An HTTP load has nobody to
 *     wake, no approval to consume and no tool part to substitute — and the
 *     three tables those live in are exactly what the finish transaction
 *     writes.
 *
 * Integration because every one of them is a database guarantee: Postgres's
 * rollback, a join against `collection_records`, and a partial unique index a
 * doubled database would simply agree with.
 *
 * ONE double, and it is a failure injector rather than a data source: a batch
 * of the delete has to RAISE somewhere Postgres will then roll back, and
 * nothing a test can put in a row makes a healthy delete fail. Everything the
 * assertions read — the records, the ledger, the operation — is real.
 */

let fx: WorkspaceFixture;
/** How many times the delete path's per-batch vector cleanup has run. */
let vectorCalls = 0;
/** Which call raises. 0 disarms it. */
let explodeOnVectorCall = 0;

await mockModule("../../src/services/episodes/vectors", {
  deleteEpisodeVectors: async () => {
    vectorCalls += 1;
    if (vectorCalls === explodeOnVectorCall) {
      throw new Error("injected: the batch died mid-delete");
    }
  },
});

const { applyChunk } =
  await import("../../../src/services/bulk-operations/chunk");
const { nextPendingChunk } =
  await import("../../../src/services/bulk-operations/begin");
const { beginApiLoad, commitApiLoad, findTeamBulkOperation, uploadApiChunk } =
  await import("../../../src/services/bulk-operations/api-load");

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;

/** A real collection with a real extension table — the writes below are real. */
const makeCollection = async (): Promise<{ id: string; key: string }> => {
  const collection = await createCollectionWithFields({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    key: `it_bulk_${(seq++).toString()}_${Date.now().toString(36)}`,
    label: "Orders",
    fields: [
      { label: "Label", key: "label", type: "text", isTitle: true },
      { label: "Amount", key: "amount", type: "number" },
    ],
  });
  return { id: collection.id, key: collection.key };
};

const seedRecords = async (
  collectionId: string,
  count: number,
): Promise<string[]> => {
  const { ids } = await bulkCreateCollectionRecords({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userIds[0],
    collectionId,
    rows: Array.from({ length: count }, (_, i) => ({
      data: { label: `Row ${i.toString()}`, amount: i },
    })),
    skipIndexReconcile: true,
  });
  return ids.flatMap((id) => (id === null ? [] : [id]));
};

const countRecords = async (collectionId: string): Promise<number> => {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM collection_records
     WHERE collection_id = ${collectionId}::uuid`);
  const n = Reflect.get(result.rows[0] ?? {}, "n");
  return typeof n === "number" ? n : -1;
};

/** A staged operation plus one parked chunk — what a worker drains. */
const stagedLoad = async (input: {
  kind: BulkOperationKind;
  collection: { id: string; key: string };
  items: Record<string, unknown>[];
  merge?: boolean;
}): Promise<{ operation: BulkOperation; chunkId: string }> => {
  const op =
    input.kind === "record_delete"
      ? "delete"
      : input.kind === "record_update"
        ? "update"
        : "create";
  const [operation] = await db
    .insert(bulkOperations)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId: (await fx.createConversation()).id,
      turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
      kind: input.kind,
      mode: "staged",
      status: "staging",
      lookupHash: `staged-${(seq++).toString()}`,
      totalItems: input.items.length,
      chunkSize: 2_000,
      params:
        op === "update"
          ? {
              op: "update",
              collectionId: input.collection.id,
              collectionKey: input.collection.key,
              merge: input.merge ?? true,
            }
          : op === "delete"
            ? {
                op: "delete",
                collectionId: input.collection.id,
                collectionKey: input.collection.key,
              }
            : {
                op: "create",
                collectionId: input.collection.id,
                collectionKey: input.collection.key,
              },
      sample: input.items.slice(0, 3),
    })
    .returning();
  if (operation === undefined) throw new Error("fixture: no operation");

  const [chunk] = await db
    .insert(bulkOperationChunks)
    .values({
      operationId: operation.id,
      chunkIndex: 0,
      itemCount: input.items.length,
      items: input.items,
    })
    .returning();
  if (chunk === undefined) throw new Error("fixture: no chunk");
  return { operation, chunkId: chunk.id };
};

/**
 * The error a call threw, or null.
 *
 * An explicit try/catch rather than `.rejects.toThrow()`: Bun types that
 * matcher as returning void, so the `await` the linters want removed is
 * exactly the one that makes it assert anything — without it the test passes
 * whatever the function did. Same reason as
 * `tests/unit/episode-vectors-contract.test.ts`.
 */
const caught = async (run: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const chunkRow = async (id: string) => {
  const row = await db.query.bulkOperationChunks.findFirst({ where: { id } });
  if (row === undefined) throw new Error("fixture: chunk vanished");
  return row;
};

describe("a chunk is one transaction", () => {
  test("a delete that raises on its third batch removes NOTHING", async () => {
    const collection = await makeCollection();
    // 1 200 ids, which the delete service splits into three 500-row batches.
    // Fewer than 501 and this test could not fail: one batch is one
    // transaction whether or not the executor opens its own.
    const ids = await seedRecords(collection.id, 1_200);
    expect(ids.length).toBe(1_200);

    const { operation, chunkId } = await stagedLoad({
      kind: "record_delete",
      collection,
      items: ids.map((id) => ({ id })),
    });

    vectorCalls = 0;
    explodeOnVectorCall = 3;
    const chunk = await chunkRow(chunkId);
    const error = await caught(() =>
      applyChunk({ operation, chunk, items: ids.map((id) => ({ id })) }),
    );
    explodeOnVectorCall = 0;
    expect(error?.message).toContain("failed");

    // The two batches that had already committed are rolled back with the
    // third. Without the executor's transaction this reads 200.
    expect(await countRecords(collection.id)).toBe(1_200);

    // And the ledger agrees: the chunk was never stamped, and its attempt was
    // handed back — so a re-queue picks it up rather than reporting it as an
    // interrupted write nobody may replay.
    const after = await chunkRow(chunkId);
    expect(after.appliedAt).toBeNull();
    expect(after.attempts).toBe(0);
  });

  test("the same chunk, un-sabotaged, deletes every row once", async () => {
    const collection = await makeCollection();
    const ids = await seedRecords(collection.id, 600);
    const { operation, chunkId } = await stagedLoad({
      kind: "record_delete",
      collection,
      items: ids.map((id) => ({ id })),
    });

    const outcome = await applyChunk({
      operation,
      chunk: await chunkRow(chunkId),
      items: ids.map((id) => ({ id })),
    });

    expect(outcome.succeeded).toBe(600);
    expect(outcome.failed).toBe(0);
    expect(await countRecords(collection.id)).toBe(0);
  });
});

describe("the collection a load names is a filter", () => {
  test("an id from another collection is refused, not deleted", async () => {
    const target = await makeCollection();
    const elsewhere = await makeCollection();
    const mine = await seedRecords(target.id, 2);
    const theirs = await seedRecords(elsewhere.id, 2);

    const items = [...mine, ...theirs].map((id) => ({ id }));
    const { operation, chunkId } = await stagedLoad({
      kind: "record_delete",
      collection: target,
      items,
    });

    const outcome = await applyChunk({
      operation,
      chunk: await chunkRow(chunkId),
      items,
    });

    expect(outcome.succeeded).toBe(2);
    expect(outcome.failed).toBe(2);
    expect(outcome.errors.map((e) => e.error).join(" ")).toContain(
      `is not in ${target.key}`,
    );
    // The other collection is untouched — which is the whole claim. Both
    // records belong to the same TEAM, so the delete service would have
    // removed them happily; only the collection predicate stops it.
    expect(await countRecords(elsewhere.id)).toBe(2);
    expect(await countRecords(target.id)).toBe(0);
  });

  test("an update of another collection's id writes nothing there", async () => {
    const target = await makeCollection();
    const elsewhere = await makeCollection();
    const mine = await seedRecords(target.id, 1);
    const theirs = await seedRecords(elsewhere.id, 1);

    const items = [...mine, ...theirs].map((id) => ({
      id,
      data: { label: "rewritten" },
    }));
    const { operation, chunkId } = await stagedLoad({
      kind: "record_update",
      collection: target,
      items,
      merge: true,
    });

    const outcome = await applyChunk({
      operation,
      chunk: await chunkRow(chunkId),
      items,
    });

    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toBe(1);

    const untouched = await db.execute(sql`
      SELECT label FROM collection_records WHERE id = ${theirs[0]}::uuid`);
    expect(Reflect.get(untouched.rows[0] ?? {}, "label")).not.toBe("rewritten");
  });
});

describe("the drain reads one chunk at a time", () => {
  test("`nextPendingChunk` walks in order and skips what is applied", async () => {
    const collection = await makeCollection();
    const { operation } = await stagedLoad({
      kind: "record_delete",
      collection,
      items: [{ id: "unused" }],
    });
    await db.insert(bulkOperationChunks).values([
      { operationId: operation.id, chunkIndex: 1, itemCount: 1 },
      {
        operationId: operation.id,
        chunkIndex: 2,
        itemCount: 1,
        appliedAt: new Date(),
      },
      { operationId: operation.id, chunkIndex: 3, itemCount: 1 },
    ]);

    // -1 is the drain's starting cursor: chunk 0 must be reachable.
    expect((await nextPendingChunk(operation.id, -1))?.chunkIndex).toBe(0);
    expect((await nextPendingChunk(operation.id, 0))?.chunkIndex).toBe(1);
    // 2 is stamped, so the cursor lands on 3 rather than handing it back.
    expect((await nextPendingChunk(operation.id, 1))?.chunkIndex).toBe(3);
    expect(await nextPendingChunk(operation.id, 3)).toBeUndefined();
  });
});

describe("a load big enough to change the embedding policy", () => {
  const semanticIndexOf = async (
    collectionId: string,
  ): Promise<boolean | null> => {
    const row = await db.query.collections.findFirst({
      columns: { semanticIndex: true },
      where: { id: collectionId },
    });
    return row?.semanticIndex ?? null;
  };

  const announce = (collection: { id: string }, rows: number, tag: string) =>
    beginApiLoad({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      op: "create",
      collectionId: collection.id,
      totalRows: rows,
      rowsDigest: `digest-${tag}-0123456789abcdef`,
      sample: [],
    });

  test("announcing 20 000 rows takes the collection out of per-record embedding", async () => {
    const collection = await makeCollection();
    expect(await semanticIndexOf(collection.id)).toBeNull();

    await announce(collection, 20_000, "big");

    // The size verdict already excludes a collection this big, but it reads
    // `reltuples`, which INSERTs do not maintain: the collection measures as
    // the empty one it is until autoanalyze catches up, so the first ~20 000
    // records would be embedded before it flips. The caller ANNOUNCED the
    // number, so the rule is applied from that, now.
    expect(await semanticIndexOf(collection.id)).toBe(false);
  });

  test("a small load leaves the decision open, and an explicit choice stands", async () => {
    const small = await makeCollection();
    await announce(small, 100, "small");
    expect(await semanticIndexOf(small.id)).toBeNull();

    const chosen = await makeCollection();
    await db.execute(sql`
      UPDATE collections SET semantic_index = true
       WHERE id = ${chosen.id}::uuid`);
    await announce(chosen, 50_000, "chosen");
    // Somebody asked for this collection to stay searchable by meaning. A row
    // count does not overrule a person.
    expect(await semanticIndexOf(chosen.id)).toBe(true);
  });
});

describe("a load with no conversation", () => {
  const digest = (tag: string): string => `digest-${tag}-0123456789abcdef`;

  test("begins, uploads, commits — and touches no conversation table", async () => {
    const collection = await makeCollection();
    const handle = await beginApiLoad({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      op: "create",
      collectionId: collection.id,
      totalRows: 3,
      rowsDigest: digest("create"),
      sample: [{ label: "a" }],
    });

    expect(handle.operation.conversationId).toBeNull();
    expect(handle.operation.turnId).toBeNull();
    // Never `staged`: a card needs somebody to show it to.
    expect(handle.operation.mode).toBe("direct");
    expect(handle.doneChunks).toEqual([]);

    const outcome = await uploadApiChunk({
      operation: handle.operation,
      chunkIndex: 0,
      rows: [{ label: "a" }, { label: "b" }, { label: "c" }],
    });
    expect(outcome.succeeded).toBe(3);

    const finished = await commitApiLoad(
      await findTeamBulkOperation(handle.operation.id, fx.teamId),
    );
    expect(finished.status).toBe("done");
    expect(finished.progress?.succeeded).toBe(3);
    expect(await countRecords(collection.id)).toBe(3);

    // The finish transaction writes four tables when there IS a conversation.
    // With none, it must write none of them rather than a row pointing at
    // nothing — a wait row with no conversation blocks a fan-in for ever.
    const tasks = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM conversation_background_tasks
       WHERE ref = ${finished.id}`);
    expect(Reflect.get(tasks.rows[0] ?? {}, "n")).toBe(0);
  });

  test("re-submitting the identical load returns the SAME operation", async () => {
    const collection = await makeCollection();
    const submit = () =>
      beginApiLoad({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: fx.userIds[0],
        op: "create",
        collectionId: collection.id,
        totalRows: 2,
        rowsDigest: digest("replay"),
        sample: [],
      });

    const first = await submit();
    const second = await submit();

    // A NULL `conversation_id` is distinct from every other one, so the
    // conversation index cannot dedupe this — only the partial index on
    // (team_id, lookup_hash) does. Without it, a client that lost its
    // connection mid-upload would open a second load of the same rows.
    expect(second.operation.id).toBe(first.operation.id);
  });

  test("a different digest is a different load", async () => {
    const collection = await makeCollection();
    const submit = (tag: string) =>
      beginApiLoad({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: fx.userIds[0],
        op: "create",
        collectionId: collection.id,
        totalRows: 2,
        rowsDigest: digest(tag),
        sample: [],
      });

    const first = await submit("one");
    const second = await submit("two");

    // The guard above must not be a collision: same collection, same row
    // count, different rows. Matching here would replay the old outcome and
    // write nothing.
    expect(second.operation.id).not.toBe(first.operation.id);
  });

  test("a collection of another team is refused before any row is sent", async () => {
    const other = await fx.createTeam();
    const collection = await makeCollection();
    await db.execute(sql`
      UPDATE collections SET team_id = ${other.id}::uuid
       WHERE id = ${collection.id}::uuid`);

    // The write services scope by team and would refuse the ROWS — but a load
    // announces its target before it has sent one, and sizes its chunks from
    // that collection. The refusal has to happen here.
    const error = await caught(() =>
      beginApiLoad({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: fx.userIds[0],
        op: "create",
        collectionId: collection.id,
        totalRows: 1,
        rowsDigest: digest("foreign"),
        sample: [],
      }),
    );
    expect(error).not.toBeNull();
  });

  test("a chunk of the wrong shape is refused whole", async () => {
    const collection = await makeCollection();
    const ids = await seedRecords(collection.id, 2);
    const handle = await beginApiLoad({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      op: "delete",
      collectionId: collection.id,
      totalRows: 2,
      rowsDigest: digest("shape"),
      sample: [],
    });

    const error = await caught(() =>
      uploadApiChunk({
        operation: handle.operation,
        chunkIndex: 0,
        // `{id}` is what a delete carries; this is a create's row.
        rows: [{ id: ids[0] }, { label: "not an id" }],
      }),
    );
    expect(error).not.toBeNull();

    // Nothing was stored and nothing was deleted — the caller can still fix
    // its rows, which is the point of checking at upload rather than at apply.
    expect(await countRecords(collection.id)).toBe(2);
    const chunks = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM bulk_operation_chunks
       WHERE operation_id = ${handle.operation.id}::uuid`);
    expect(Reflect.get(chunks.rows[0] ?? {}, "n")).toBe(0);
  });
});
