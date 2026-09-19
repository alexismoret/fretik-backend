import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { runTableSync } from "../../../src/services/collection-sync/run-table-sync";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  createTableSource,
  dbNow,
  readTracked,
  row,
  singlePageUpstream,
  type TableSourceFixture,
  type UpstreamRow,
} from "./lib/table-source";

/**
 * The orphan bracket, and the floor that stops it.
 *
 * TWO FAILURES THIS SUITE EXISTS FOR, both of which destroy data and both of
 * which shipped:
 *
 *  - A `200 {items: []}` orphaned EVERY record. Under `delete` the collection
 *    went in one run. There was no floor at all.
 *  - With `{"$since": true}` bound, the second run is handed only the rows that
 *    changed — and the diff treated everything else as gone. A source syncing
 *    incrementally under `delete` would empty itself on its second run, which
 *    is the most dangerous shape here because it looks like a working sync
 *    until it does not.
 *
 * Integration because "which records did this walk not see" is a query over
 * `record_sync_state.synced_at` against the run's `started_at`, and both
 * timestamps are Postgres's. A test with a JavaScript clock could not tell the
 * two apart to the microsecond, and the whole bracket turns on that comparison.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const walk = async (
  fixture: TableSourceFixture,
  rows: UpstreamRow[],
  options: { fullWalk?: boolean; ignoreOrphanFloor?: boolean } = {},
) => {
  const source = await fixture.reload();
  // `started_at` comes from the database on a real run; here the walk's own
  // boundary is taken the same way, so `synced_at < walkStartedAt` compares
  // two clocks that agree. See `dbNow`.
  return runTableSync({
    source,
    action: singlePageUpstream(rows).action,
    deadlineAt: Date.now() + 60_000,
    runId: crypto.randomUUID(),
    walkStartedAt: await dbNow(),
    configHash: "fixed",
    fullWalk: options.fullWalk ?? true,
    ignoreOrphanFloor: options.ignoreOrphanFloor ?? false,
  });
};

const seed = (count: number): UpstreamRow[] =>
  Array.from({ length: count }, (_, i) =>
    row(`r${String(i).padStart(3, "0")}`),
  );

const statuses = async (sourceId: string): Promise<Record<string, number>> => {
  const tracked = await readTracked(sourceId);
  const counts: Record<string, number> = {};
  for (const entry of tracked) {
    const key = entry.status ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe("the orphan bracket", () => {
  test("a believable loss is applied: 10 of 100 gone become `missing`", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(100);
    await walk(fixture, all);

    const outcome = await walk(fixture, all.slice(0, 90));

    expect(outcome.kind).toBe("complete");
    expect(outcome.counts.orphanCount).toBe(10);
    expect(await statuses(fixture.source.id)).toEqual({ ok: 90, missing: 10 });
  });

  test("the unchanged rows are NOT orphans — `synced_at` is what says so", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(50);
    await walk(fixture, all);

    // Every row identical: no UPDATE, no journal entry, and — the thing this
    // asserts — every row still stamped as seen. Without `touchRecordSyncState`
    // a healthy sync would orphan its own collection on its second run.
    const outcome = await walk(fixture, all);

    // `complete`, not just "orphanCount 0". Dropping the stamp makes all 50
    // look unseen, which is the FLOOR — and a floor also reports zero orphans
    // and leaves every status `ok`, so the three assertions below pass without
    // it. The kind is the only one that can tell the two apart.
    expect(outcome.kind).toBe("complete");
    expect(outcome.counts.unchangedCount).toBe(50);
    expect(outcome.counts.orphanCount).toBe(0);
    expect(await statuses(fixture.source.id)).toEqual({ ok: 50 });
  });

  test("70 of 100 gone hits the floor: NOTHING is applied and a reason is returned", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(100);
    await walk(fixture, all);

    const outcome = await walk(fixture, all.slice(0, 30));

    expect(outcome.kind).toBe("floor");
    if (outcome.kind !== "floor") throw new Error("expected the floor");
    expect(outcome.reason).toContain("30 of the 100");
    expect(outcome.counts.orphanCount).toBe(0);
    // Not one row marked. The 30 that came back are `ok`; the other 70 keep the
    // status they had, which is also `ok` — they are not missing, they are
    // unexplained, and that is the whole difference.
    expect(await statuses(fixture.source.id)).toEqual({ ok: 100 });
  });

  test("an empty answer hits the floor whatever the ratio says", async () => {
    const fixture = await createTableSource(fx);
    await walk(fixture, seed(3));

    // Three rows: 3 > 0.2 × 3 is true but 3 ≥ 20 is not, so the ratio alone
    // would let this through — and "the app answered nothing" is the single
    // commonest way a bad argument shows up.
    const outcome = await walk(fixture, []);

    expect(outcome.kind).toBe("floor");
    expect(await statuses(fixture.source.id)).toEqual({ ok: 3 });
  });

  test("a confirmed full resync applies the policy the floor refused", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(100);
    await walk(fixture, all);
    expect((await walk(fixture, all.slice(0, 30))).kind).toBe("floor");

    const confirmed = await walk(fixture, all.slice(0, 30), {
      ignoreOrphanFloor: true,
    });

    expect(confirmed.kind).toBe("complete");
    expect(confirmed.counts.orphanCount).toBe(70);
    expect(await statuses(fixture.source.id)).toEqual({ ok: 30, missing: 70 });
  });

  test("an INCREMENTAL walk never diffs, however short its answer", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(100);
    await walk(fixture, all);

    // The second run is handed the two rows that changed. Under the old diff
    // this orphaned 98 records — and under `delete` it would have removed them.
    const outcome = await walk(fixture, all.slice(0, 2), { fullWalk: false });

    expect(outcome.kind).toBe("complete");
    expect(outcome.counts.orphanCount).toBe(0);
    expect(await statuses(fixture.source.id)).toEqual({ ok: 100 });
  });

  test("a row already `missing` does not count towards the floor twice", async () => {
    const fixture = await createTableSource(fx);
    const all = seed(100);
    await walk(fixture, all);
    // 30 rows genuinely gone, applied because a person confirmed it.
    await walk(fixture, all.slice(0, 70), { ignoreOrphanFloor: true });
    expect(await statuses(fixture.source.id)).toEqual({ ok: 70, missing: 30 });

    // Every following run answers with the same healthy 70. Counting the 30
    // already-missing rows again would put the census at 30 of 100 — over the
    // ratio — so the source would trip the floor on every run from here and
    // never sync again. That is what excluding them prevents.
    const outcome = await walk(fixture, all.slice(0, 70));

    expect(outcome.kind).toBe("complete");
    expect(outcome.counts.orphanCount).toBe(0);
    expect(outcome.counts.unchangedCount).toBe(70);
  });

  test("`reject` moves the rows out of the default views, `delete` removes them", async () => {
    const rejecting = await createTableSource(fx, { orphanPolicy: "reject" });
    const all = seed(100);
    await walk(rejecting, all);
    await walk(rejecting, all.slice(0, 90));

    const rejected = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM collection_records
       WHERE sync_source_id = ${rejecting.source.id}::uuid
         AND status = 'rejected'::ontology_status`);
    expect(Reflect.get(rejected.rows[0] ?? {}, "n")).toBe(10);

    const deleting = await createTableSource(fx, { orphanPolicy: "delete" });
    await walk(deleting, all);
    await walk(deleting, all.slice(0, 90));

    expect((await readTracked(deleting.source.id)).length).toBe(90);
  });
});
