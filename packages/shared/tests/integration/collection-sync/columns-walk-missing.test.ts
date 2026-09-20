import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { SYNC_LIMITS } from "../../../src/schemas/collection-sync";
import { markRecordsPending } from "../../../src/services/collection-sync/record-state";
import { runColumnsWalk } from "../../../src/services/collection-sync/walk-by-match-field";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  type ColumnsWalkFixture,
  createColumnsWalkSource,
  dbNow,
  offsetUpstream,
  singlePageUpstream,
  type UpstreamRow,
} from "./lib/table-source";

/**
 * What a COMPLETE walk owes the records it did not match.
 *
 * The mirror of the orphan bracket, and deliberately much smaller. A `table`
 * source owns its records, so a row that stopped coming back may have to be
 * rejected or deleted — which is why that path has a floor and a confirmation
 * in front of it. This source owns nothing: every stored value stays, and
 * `missing` is a note beside the column saying the app had no answer.
 *
 * What it must still get right is WHICH records, and there the failure modes
 * are the same ones the bracket had: mark too many and a healthy source
 * reports its whole collection unanswered; mark on an incremental or truncated
 * walk and it marks everything the app simply was not asked about.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const appRow = (siret: string, amount: number): UpstreamRow => ({
  id: siret,
  label: `Row ${siret}`,
  amount,
});

const walk = async (
  fixture: ColumnsWalkFixture,
  rows: UpstreamRow[],
  options: { fullWalk?: boolean } = {},
) =>
  await runColumnsWalk({
    source: await fixture.reload(),
    action: singlePageUpstream(rows).action,
    deadlineAt: Date.now() + 60_000,
    runId: crypto.randomUUID(),
    walkStartedAt: await dbNow(),
    configHash: "fixed",
    fullWalk: options.fullWalk ?? true,
    ignoreOrphanFloor: false,
  });

const statusOf = async (
  sourceId: string,
  recordId: string,
): Promise<string | null> => {
  const result = await db.execute(sql`
    SELECT status::text AS status FROM record_sync_state
     WHERE sync_source_id = ${sourceId}::uuid AND record_id = ${recordId}::uuid`);
  const status = Reflect.get(result.rows[0] ?? {}, "status");
  return typeof status === "string" ? status : null;
};

describe("after a complete walk", () => {
  test("a tracked record the walk did not match becomes missing", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["A", "B"] });
    await walk(h, [appRow("A", 1), appRow("B", 2)]);

    // Second complete walk, and "B" is gone from the app's list.
    const second = await walk(h, [appRow("A", 1)]);
    expect(second.counts.missingCount).toBe(1);

    const a = h.recordIds.get("A");
    const b = h.recordIds.get("B");
    if (a === undefined || b === undefined) throw new Error("fixture");
    expect(await statusOf(h.source.id, a)).toBe("ok");
    expect(await statusOf(h.source.id, b)).toBe("missing");
  });

  test("a record this source never answered about is marked too", async () => {
    // Without this half a record whose key simply does not exist upstream sits
    // with an empty column and no explanation, for ever. The first complete
    // walk is exactly when that is worth saying.
    const h = await createColumnsWalkSource(fx, { keys: ["X", "NEVER"] });

    const result = await walk(h, [appRow("X", 1)]);
    expect(result.counts.missingCount).toBe(1);

    const never = h.recordIds.get("NEVER");
    if (never === undefined) throw new Error("fixture");
    expect(await statusOf(h.source.id, never)).toBe("missing");
  });

  test("a record with no key at all is left alone", async () => {
    // Nothing was asked about it, so there is nothing to report. Marking it
    // would put "no answer" beside a column whose row never had a question.
    const h = await createColumnsWalkSource(fx, { keys: ["Y", null] });

    const result = await walk(h, [appRow("Y", 1)]);
    expect(result.counts.missingCount).toBe(0);

    const tracked = await db.execute(sql`
      SELECT count(*)::int AS n FROM record_sync_state
       WHERE sync_source_id = ${h.source.id}::uuid`);
    expect(Reflect.get(tracked.rows[0] ?? {}, "n")).toBe(1);
  });

  test("a missing record that reappears comes back ok", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["R"] });
    await walk(h, []);
    const r = h.recordIds.get("R");
    if (r === undefined) throw new Error("fixture");
    expect(await statusOf(h.source.id, r)).toBe("missing");

    // The hash short-circuit requires `status = 'ok'`, so a `missing` row is
    // re-written even when its values are identical — which is what clears it.
    await walk(h, [appRow("R", 1)]);
    expect(await statusOf(h.source.id, r)).toBe("ok");
  });

  test("a row queued before the walk is answered; one queued after waits", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["P1", "P2"] });
    const p1 = h.recordIds.get("P1");
    const p2 = h.recordIds.get("P2");
    if (p1 === undefined || p2 === undefined) throw new Error("fixture");

    // `markRecordsPending` stamps `synced_at = now()`, so a row queued BEFORE
    // the walk starts is older than its boundary and a row queued during it is
    // not. The first was evaluated by this walk; the second was not.
    await markRecordsPending(h.source.id, [p1]);
    const startedAt = await dbNow();
    await markRecordsPending(h.source.id, [p2]);

    await runColumnsWalk({
      source: await h.reload(),
      action: singlePageUpstream([]).action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: startedAt,
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(await statusOf(h.source.id, p1)).toBe("missing");
    expect(await statusOf(h.source.id, p2)).toBe("pending");
  });
});

describe("a walk that cannot speak for the whole list", () => {
  test("an incremental walk marks nothing missing", async () => {
    // It was handed only what CHANGED, so "not in the answer" means "did not
    // change". This is the shape that emptied a collection on its second run
    // before the `table` path learned the same rule.
    const h = await createColumnsWalkSource(fx, { keys: ["I1", "I2"] });
    await walk(h, [appRow("I1", 1), appRow("I2", 2)]);

    const incremental = await walk(h, [appRow("I1", 9)], { fullWalk: false });
    expect(incremental.counts.missingCount).toBe(0);

    const i2 = h.recordIds.get("I2");
    if (i2 === undefined) throw new Error("fixture");
    expect(await statusOf(h.source.id, i2)).toBe("ok");
  });

  test("a truncated walk marks nothing missing", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["T1", "T2", "T3"] });
    const upstream = offsetUpstream(
      [[appRow("T1", 1), appRow("T2", 2)], [appRow("T3", 3)]],
      { pageSize: 2 },
    );

    const result = await runColumnsWalk({
      source: {
        ...(await h.reload()),
        // Stop the walk at its own ceiling, before it has seen every row.
        rowCap: 2,
      },
      action: upstream.action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: await dbNow(),
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(result.counts.truncated).toBe(true);
    expect(result.counts.missingCount).toBe(0);
    expect(SYNC_LIMITS.maxRowCap).toBeGreaterThan(2);
  });
});
