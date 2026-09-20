import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { collectionSyncSources } from "../../../src/db/schema";
import { SYNC_LIMITS } from "../../../src/schemas/collection-sync";
import {
  invalidateLookupSourceCache,
  invalidateLookupSources,
} from "../../../src/services/collection-sync/invalidate-on-change";
import { selectLookupCandidates } from "../../../src/services/collection-sync/lookup-candidates";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * Which records a `lookup` run refreshes, and which changes make one due.
 *
 * TWO DEFECTS THIS COVERS.
 *
 *  - The work list was ONE query: the whole collection left-joined against the
 *    whole state table and sorted by `CASE … , synced_at`. That is O(collection)
 *    per run — a 50 000-row collection sorted 50 000 rows to take 200, four
 *    times an hour, on a path a record edit triggers interactively. It is now
 *    five `LIMIT` queries against three indexes, each stopping as soon as the
 *    list is full.
 *  - A record the app has no row for was asked about on every single run, for
 *    ever, because a successful call with an empty answer wrote no state. The
 *    `missing` status and its rest period are what stop that; the last case
 *    here is the rest period.
 *
 * Integration because the ORDER is the priority and the priority is the
 * `ORDER BY`. Nothing short of real rows in `record_sync_state` can show that
 * `pending` outranks stale, or that a `missing` row stays out until its week is
 * up.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  invalidateLookupSourceCache();
  await fx.cleanup();
});

interface Harness {
  sourceId: string;
  collectionId: string;
  recordIds: string[];
  source: typeof collectionSyncSources.$inferSelect;
}

const harness = async (recordCount: number): Promise<Harness> => {
  const collection = await fx.createCollection();
  const connection = await fx.createConnection();
  const [source] = await db
    .insert(collectionSyncSources)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: collection.id,
      kind: "lookup",
      connectionId: connection.id,
      providerKey: connection.providerKey,
      operation: "get_order",
      args: { reference: { $field: "reference" } },
      fieldMapping: [{ path: "label", fieldKey: "label" }],
      schedule: { mode: "interval", everyMinutes: 15 },
    })
    .returning();
  if (source === undefined) throw new Error("fixture: no source");

  const recordIds: string[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    const record = await fx.createRecord({ collectionId: collection.id });
    recordIds.push(record.id);
  }
  return {
    sourceId: source.id,
    collectionId: collection.id,
    recordIds,
    source,
  };
};

const setState = async (
  sourceId: string,
  recordId: string,
  status: string,
  syncedAt: string,
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO record_sync_state (record_id, sync_source_id, status, synced_at)
    VALUES (${recordId}::uuid, ${sourceId}::uuid,
            ${status}::record_sync_status, now() - ${sql.raw(`interval '${syncedAt}'`)})
    ON CONFLICT (record_id, sync_source_id) DO UPDATE
       SET status = EXCLUDED.status, synced_at = EXCLUDED.synced_at`);
};

const reload = async (sourceId: string) => {
  const row = await db.query.collectionSyncSources.findFirst({
    where: { id: sourceId },
  });
  if (row === undefined) throw new Error("fixture: source vanished");
  return row;
};

describe("the lookup work list", () => {
  test("named records come first, and only the source's own collection's", async () => {
    const h = await harness(3);
    const stranger = await fx.createCollection();
    const outsider = await fx.createRecord({ collectionId: stranger.id });

    const mine = h.recordIds[0];
    if (mine === undefined) throw new Error("fixture: three records");
    const picked = await selectLookupCandidates({
      source: h.source,
      limit: 10,
      requested: [mine, outsider.id],
    });

    // The caller's list is a request, not an authorisation: a record of another
    // collection is dropped, however explicitly it was named.
    expect(picked.map((c) => c.recordId)).toContain(mine);
    expect(picked.map((c) => c.recordId)).not.toContain(outsider.id);
  });

  test("`pending` outranks a stale row, and a stale row outranks a fresh one", async () => {
    const h = await harness(3);
    const [a, b, c] = h.recordIds;
    if (!a || !b || !c) throw new Error("fixture: three records");
    await setState(h.sourceId, a, "ok", "1 minute");
    await setState(h.sourceId, b, "ok", "10 days");
    await setState(h.sourceId, c, "pending", "1 second");

    const picked = await selectLookupCandidates({ source: h.source, limit: 2 });

    // Two seats: the queued one and the stalest. Not the one refreshed a
    // minute ago, whatever its `synced_at` ordering would say.
    expect(picked.map((entry) => entry.recordId)).toEqual([c, b]);
  });

  test("untracked records are picked up, then the scan records that it finished", async () => {
    const h = await harness(4);

    const first = await selectLookupCandidates({ source: h.source, limit: 10 });
    expect(first.length).toBe(4);
    expect(first.every((entry) => entry.contentHash === null)).toBe(true);

    // The scan reached the end of the collection, so it says so — and a second
    // run does NOT re-walk the anti-join, which is the whole cost fix. (The
    // records are still untracked here: nothing has written their state.)
    const after = await reload(h.sourceId);
    expect(after.untrackedScanDoneAt).not.toBeNull();
    expect(after.untrackedScanCursor).toBeNull();

    const second = await selectLookupCandidates({ source: after, limit: 10 });
    expect(second).toEqual([]);
  });

  test("a long collection is scanned at a cursor, a page at a time", async () => {
    const h = await harness(5);

    const first = await selectLookupCandidates({ source: h.source, limit: 2 });
    expect(first.length).toBe(2);
    const afterFirst = await reload(h.sourceId);
    // A FULL page means there may be more, so the walk stores where it got to
    // and does not claim to be done.
    expect(afterFirst.untrackedScanCursor).toBe(first[1]?.recordId ?? null);
    expect(afterFirst.untrackedScanDoneAt).toBeNull();

    const second = await selectLookupCandidates({
      source: afterFirst,
      limit: 2,
    });
    expect(second.map((entry) => entry.recordId)).not.toEqual(
      first.map((entry) => entry.recordId),
    );
  });

  test("a `missing` row rests, and comes back after its retry window", async () => {
    const h = await harness(2);
    const [a, b] = h.recordIds;
    if (!a || !b) throw new Error("fixture: two records");
    await setState(h.sourceId, a, "missing", "1 hour");
    await setState(h.sourceId, b, "ok", "1 hour");
    // The untracked scan has nothing left to find.
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET untracked_scan_done_at = now()
       WHERE id = ${h.sourceId}::uuid`);

    const resting = await selectLookupCandidates({
      source: await reload(h.sourceId),
      limit: 10,
    });
    // An hour is not enough. This is the 19 200 wasted calls a day.
    expect(resting.map((entry) => entry.recordId)).toEqual([b]);

    const days = SYNC_LIMITS.lookupMissingRetryMs / 86_400_000 + 1;
    await setState(h.sourceId, a, "missing", `${String(days)} days`);

    const rested = await selectLookupCandidates({
      source: await reload(h.sourceId),
      limit: 10,
    });
    expect(rested.map((entry) => entry.recordId).sort()).toEqual([a, b].sort());
  });

  /**
   * THE RUN THAT WAS NOT ASKED FOR.
   *
   * A `lookup` source does not only run on its cadence: any change to a bound
   * column sets `next_run_at = now()`, and the sweep then claims it as an
   * ordinary `schedule` run. The rotation used to fill whatever seats the
   * queued records left over — so one edit on a 200-row collection cost two
   * hundred upstream calls, a hundred and ninety-nine of them re-asking rows
   * answered a minute earlier. The counters called it `unchanged: 199`, which
   * is what a healthy sync looks like, so nothing anywhere said it happened.
   */
  test("a run triggered by one edit does not fill its seats with fresh rows", async () => {
    const h = await harness(6);
    const [edited, ...others] = h.recordIds;
    if (edited === undefined || others.length !== 5) {
      throw new Error("fixture: six records");
    }
    // The last run answered all six a minute ago; then one record was edited.
    for (const id of others) await setState(h.sourceId, id, "ok", "1 minute");
    await setState(h.sourceId, edited, "pending", "1 minute");
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET untracked_scan_done_at = now()
       WHERE id = ${h.sourceId}::uuid`);

    const picked = await selectLookupCandidates({
      source: await reload(h.sourceId),
      limit: SYNC_LIMITS.lookupBatchSize,
    });

    // One call, for the one row that changed. The other five are barely older
    // than a minute on a quarter-hourly source: nothing is due.
    expect(picked.map((entry) => entry.recordId)).toEqual([edited]);
  });

  test("the rotation still comes round once the cadence has passed", async () => {
    const h = await harness(3);
    const [a, b, c] = h.recordIds;
    if (!a || !b || !c) throw new Error("fixture: three records");
    // Half of fifteen minutes is the floor, so eight minutes is due and six is
    // not. The middle case is what stops the floor becoming a freeze.
    await setState(h.sourceId, a, "ok", "8 minutes");
    await setState(h.sourceId, b, "ok", "6 minutes");
    await setState(h.sourceId, c, "ok", "2 hours");
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET untracked_scan_done_at = now()
       WHERE id = ${h.sourceId}::uuid`);

    const picked = await selectLookupCandidates({
      source: await reload(h.sourceId),
      limit: SYNC_LIMITS.lookupBatchSize,
    });

    expect(picked.map((entry) => entry.recordId)).toEqual([c, a]);
  });

  /**
   * An hourly source gives its rows half an hour of grace, not seven minutes.
   * Reading the floor off the schedule is what keeps "how often" meaning one
   * thing: a row refreshed inside the current cycle is not asked about again.
   */
  test("the floor follows the source's own cadence", async () => {
    const h = await harness(2);
    const [a, b] = h.recordIds;
    if (!a || !b) throw new Error("fixture: two records");
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET schedule = '{"mode":"interval","everyMinutes":60}'::jsonb,
             untracked_scan_done_at = now()
       WHERE id = ${h.sourceId}::uuid`);
    await setState(h.sourceId, a, "ok", "20 minutes");
    await setState(h.sourceId, b, "ok", "40 minutes");

    const picked = await selectLookupCandidates({
      source: await reload(h.sourceId),
      limit: SYNC_LIMITS.lookupBatchSize,
    });

    // Twenty minutes into an hourly cycle is not stale. Forty is.
    expect(picked.map((entry) => entry.recordId)).toEqual([b]);
  });
});

describe("a record change makes a lookup source due", () => {
  test("only records of the source's OWN collection are marked", async () => {
    const h = await harness(1);
    invalidateLookupSourceCache(fx.teamId);
    const other = await fx.createCollection();
    const elsewhere = await fx.createRecord({ collectionId: other.id });
    const mine = h.recordIds[0];
    if (mine === undefined) throw new Error("fixture: one record");

    // Both records, same team, same change set. Only one belongs to the
    // collection this source fills — and the collection predicate lives in the
    // INSERT's own statement, which is the only place it can be observed.
    const queued = await invalidateLookupSources([
      { recordId: mine, teamId: fx.teamId, changedKeys: [], agentKey: null },
      {
        recordId: elsewhere.id,
        teamId: fx.teamId,
        changedKeys: [],
        agentKey: null,
      },
    ]);

    expect(queued).toBe(1);
    const pending = await db.execute(sql`
      SELECT record_id::text AS id
        FROM record_sync_state
       WHERE sync_source_id = ${h.sourceId}::uuid
         AND status = 'pending'::record_sync_status`);
    expect(pending.rows.map((r) => Reflect.get(r, "id"))).toEqual([mine]);
  });

  test("a change to a key the arguments do not read is ignored", async () => {
    const h = await harness(1);
    invalidateLookupSourceCache(fx.teamId);
    const mine = h.recordIds[0];
    if (mine === undefined) throw new Error("fixture: one record");

    const queued = await invalidateLookupSources([
      {
        recordId: mine,
        teamId: fx.teamId,
        changedKeys: ["unrelated_note"],
        agentKey: null,
      },
    ]);

    expect(queued).toBe(0);
  });
});
