import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { collectionSyncSources } from "../../../src/db/schema";
import { claimDueSyncSources } from "../../../src/services/collection-sync/sweep";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The sweep's claim: exactly once per source, and fair between teams.
 *
 * Integration because the claim IS the statement. Every guarantee below lives
 * in SQL — `FOR UPDATE SKIP LOCKED`, a `row_number()` window, and a predicate
 * repeated on the outer `UPDATE` — and none of them can be observed without two
 * transactions racing on a real Postgres. A mocked `db` would return whatever
 * the test told it to and prove nothing.
 *
 * WHAT THIS CAUGHT. The first version put the `claimed_at` predicate only in
 * the subselect. Under READ COMMITTED, an `UPDATE` that blocks on a row another
 * transaction is writing re-evaluates ITS OWN `WHERE` against the new row
 * version (EPQ) — not the subselect's — so with nothing left to re-check both
 * sweeps claimed the same source. Production never noticed because BullMQ
 * collapsed the two jobs onto one `jobId`: the bug was masked by luck, and the
 * comment above the function asserted the opposite.
 */

let fx: WorkspaceFixture;
/** Three teams: one is the fixture's own, two are its siblings. */
let teamIds: string[] = [];

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  const second = await fx.createTeam();
  const third = await fx.createTeam();
  teamIds = [fx.teamId, second.id, third.id];
});

afterAll(async () => {
  await fx.cleanup();
});

/** Four due sources per team, all overdue, none claimed. */
const seedDueSources = async (perTeam: number): Promise<string[]> => {
  await db.execute(sql`
    DELETE FROM collection_sync_sources
     WHERE organization_id = ${fx.organizationId}::uuid`);
  const collection = await fx.createCollection();
  const ids: string[] = [];
  for (const [teamIndex, teamId] of teamIds.entries()) {
    for (let i = 0; i < perTeam; i += 1) {
      const [row] = await db
        .insert(collectionSyncSources)
        .values({
          organizationId: fx.organizationId,
          teamId,
          collectionId: collection.id,
          kind: "columns",
          providerKey: "it-app",
          operation: "list_orders",
          schedule: { mode: "interval", everyMinutes: 15 },
          // Staggered so `next_run_at` gives a deterministic rank inside each
          // team, and so team 0's rows are the most overdue of all — the exact
          // shape that starved everybody else before the window function.
          nextRunAt: new Date(
            Date.now() - 3_600_000 + teamIndex * 1_000 + i * 10,
          ),
        })
        .returning({ id: collectionSyncSources.id });
      if (row) ids.push(row.id);
    }
  }
  return ids;
};

describe("claimDueSyncSources", () => {
  beforeEach(async () => {
    await seedDueSources(4);
  });

  test("six concurrent sweeps claim each source exactly once", async () => {
    // Ten rounds, because a race that fires once is a race that passed once.
    for (let round = 0; round < 10; round += 1) {
      await seedDueSources(4);

      const claims = await Promise.all(
        Array.from({ length: 6 }, () =>
          claimDueSyncSources({ limit: 4, perTeam: 2 }),
        ),
      );

      const taken = claims.flat().map((source) => source.id);
      const unique = new Set(taken);
      expect(unique.size).toBe(taken.length);
    }
  });

  test("no team takes more than `perTeam` seats, however overdue it is", async () => {
    const claimed = await claimDueSyncSources({ limit: 50, perTeam: 2 });

    const byTeam = new Map<string, number>();
    for (const source of claimed) {
      byTeam.set(source.teamId, (byTeam.get(source.teamId) ?? 0) + 1);
    }
    // Team 0 holds the four most overdue sources in the database. Ordering by
    // `next_run_at` alone would hand it every seat — which is the starvation
    // the window function exists to prevent.
    for (const [, count] of byTeam) expect(count).toBeLessThanOrEqual(2);
    expect(byTeam.size).toBe(3);
    expect(claimed.length).toBe(6);
  });

  test("the rank is the per-team position, so every team's first comes first", async () => {
    const claimed = await claimDueSyncSources({ limit: 50, perTeam: 2 });

    const firsts = claimed.filter((source) => source.rank === 1);
    expect(firsts.length).toBe(3);
    expect(new Set(firsts.map((s) => s.teamId)).size).toBe(3);
    for (const source of claimed) {
      expect(source.rank).toBeLessThanOrEqual(2);
      expect(source.rank).toBeGreaterThanOrEqual(1);
    }
  });

  test("a claimed source is not claimed again until its lease expires", async () => {
    const first = await claimDueSyncSources({ limit: 50, perTeam: 4 });
    expect(first.length).toBe(12);

    const second = await claimDueSyncSources({ limit: 50, perTeam: 4 });
    expect(second).toEqual([]);

    // Age one claim past `SYNC_CLAIM_TIMEOUT_MS` — a runner that died mid-walk.
    const stale = first[0];
    if (stale === undefined) throw new Error("expected a claimed source");
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET claimed_at = now() - interval '20 minutes'
       WHERE id = ${stale.id}::uuid`);

    const third = await claimDueSyncSources({ limit: 50, perTeam: 4 });
    expect(third.map((s) => s.id)).toEqual([stale.id]);
  });

  test("a disabled or manual source is never due", async () => {
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET enabled = false
       WHERE organization_id = ${fx.organizationId}::uuid
         AND team_id = ${teamIds[0] ?? ""}::uuid`);
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET next_run_at = NULL
       WHERE organization_id = ${fx.organizationId}::uuid
         AND team_id = ${teamIds[1] ?? ""}::uuid`);

    const claimed = await claimDueSyncSources({ limit: 50, perTeam: 4 });

    expect(new Set(claimed.map((s) => s.teamId))).toEqual(
      new Set([teamIds[2] ?? ""]),
    );
  });
});
