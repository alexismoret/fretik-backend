import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { runColumnsWalk } from "../../../src/services/collection-sync/walk-by-match-field";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  type ColumnsWalkFixture,
  createColumnsWalkSource,
  dbNow,
  singlePageUpstream,
  type UpstreamRow,
} from "./lib/table-source";

/**
 * A `columns` source read BY LIST: the app's list is walked and each row is
 * matched to a record the TEAM already keeps.
 *
 * This is the shape that makes a second and a third app affordable on one
 * collection. The alternative — one call per record — is the same data at one
 * request per row: 20 000 requests where this costs 20.
 *
 * Integration, not unit, and specifically because of where the values live. A
 * record's `siret` is a physical column of `data.coll_<id>`, and the match is
 * an indexed `= ANY` against it. A double would prove the Map bookkeeping and
 * nothing about the query — which is the half that can silently match nothing
 * and still report a healthy run.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

/** An upstream row keyed on `id`, which the fixture compares against `siret`. */
const appRow = (siret: string | number, amount: number): UpstreamRow => ({
  id: String(siret),
  label: `Row ${String(siret)}`,
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

/** What the source wrote into the two columns it owns. */
const readFilled = async (
  collectionId: string,
  recordId: string,
): Promise<{ label: unknown; amount: unknown }> => {
  const result = await db.execute(
    sql.raw(
      `SELECT label, amount FROM data.coll_${collectionId.replace(/-/g, "")} WHERE id = '${recordId}'`,
    ),
  );
  const row = result.rows[0] ?? {};
  return {
    label: Reflect.get(row, "label"),
    amount: Reflect.get(row, "amount"),
  };
};

describe("matching an app's rows to the team's records", () => {
  test("a row lands on the record whose match column equals its key", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["A1", "B2", "C3"] });

    const first = await walk(h, [appRow("A1", 10), appRow("B2", 20)]);
    expect(first.kind).toBe("complete");
    expect(first.counts.updatedCount).toBe(2);
    expect(first.counts.createdCount).toBe(0);

    const a1 = h.recordIds.get("A1");
    expect(a1).toBeDefined();
    if (a1 === undefined) return;
    expect(await readFilled(h.collectionId, a1)).toEqual({
      label: "Row A1",
      amount: "10",
    });
  });

  test("an identical second walk writes nothing", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["D4", "E5"] });
    const rows = [appRow("D4", 1), appRow("E5", 2)];

    await walk(h, rows);
    const again = await walk(h, rows);
    expect(again.counts.updatedCount).toBe(0);
    expect(again.counts.unchangedCount).toBe(2);
  });

  test("two records sharing one key both receive the answer", async () => {
    // Not a defect to guard against — a match column is not unique, and two
    // records carrying the same reference are two records the app's answer is
    // about. Keeping only the first would leave one stale for ever with
    // nothing on screen to say why.
    const h = await createColumnsWalkSource(fx, { keys: ["SAME", "SAME"] });

    const result = await walk(h, [appRow("SAME", 7)]);
    expect(result.counts.updatedCount).toBe(2);
  });

  test("a record of another team is never matched, in the same table", async () => {
    // The extension table of an org-scoped collection is shared across teams,
    // which is why every match query carries `_team_id`.
    const other = await fx.createTeam();
    const h = await createColumnsWalkSource(fx, {
      keys: ["MINE"],
      otherTeamId: other.id,
      otherTeamKeys: ["THEIRS"],
    });

    const result = await walk(h, [appRow("MINE", 1), appRow("THEIRS", 2)]);
    expect(result.counts.updatedCount).toBe(1);
    expect(result.counts.unmatchedCount).toBe(1);
  });

  test('a numeric column matches the app\'s "007" to the stored 7', async () => {
    // Both sides go through `matchKeyOf`. Compared as they arrive, the app's
    // JSON string and Postgres' numeric never meet, and the run reports every
    // row unmatched while looking perfectly healthy.
    const h = await createColumnsWalkSource(fx, {
      matchType: "number",
      keys: [7, 42],
    });

    const result = await walk(h, [appRow("007", 100), appRow("42.0", 200)]);
    expect(result.counts.updatedCount).toBe(2);
    expect(result.counts.unmatchedCount).toBe(0);
  });

  test("a row matching no record is counted, and creates nothing", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["K1"] });

    const result = await walk(h, [appRow("K1", 1), appRow("UNKNOWN", 2)]);
    expect(result.counts.unmatchedCount).toBe(1);
    expect(result.counts.createdCount).toBe(0);

    const count = await db.execute(sql`
      SELECT count(*)::int AS n FROM collection_records
       WHERE collection_id = ${h.collectionId}::uuid`);
    expect(Reflect.get(count.rows[0] ?? {}, "n")).toBe(1);
  });

  test("a row with no key at all is counted, not dropped in silence", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["K2"] });

    const result = await walk(h, [
      appRow("K2", 1),
      { id: "", label: "keyless", amount: 3 },
    ]);
    expect(result.counts.unmatchedCount).toBe(1);
    expect(result.counts.failedCount).toBe(0);
  });

  test("the match column is never written by the source that reads it", async () => {
    const h = await createColumnsWalkSource(fx, { keys: ["Z9"] });
    await walk(h, [appRow("Z9", 5)]);

    const result = await db.execute(
      sql.raw(
        `SELECT siret FROM data.coll_${h.collectionId.replace(/-/g, "")} WHERE siret IS NOT NULL`,
      ),
    );
    expect(result.rows.length).toBe(1);
    expect(Reflect.get(result.rows[0] ?? {}, "siret")).toBe("Z9");
  });
});
