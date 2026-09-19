import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import {
  collectionSyncRuns,
  collectionSyncSources,
} from "../../../src/db/schema";
import { getSyncSource } from "../../../src/services/collection-sync/get-source";
import { listSyncRuns } from "../../../src/services/collection-sync/list-runs";
import { listSyncSources } from "../../../src/services/collection-sync/list-sources";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The `teamId` predicate on every by-id read — the cross-tenant leak.
 *
 * `getSyncSource` and `listSyncRuns` take an id from the URL. Both are reached
 * by an authenticated member of SOME team, so the id being valid proves nothing
 * about whose it is: without the predicate, any member of any team could read
 * another team's sync configuration — its arguments, its connection, its
 * upstream operation — by guessing or by having once been shown one.
 *
 * THE FIXTURE IS THE POINT. Each row below differs from a legitimate one in
 * EXACTLY ONE COLUMN: a source in this organization and this collection but
 * another team, a run whose `team_id` alone is wrong. A test that used a whole
 * second workspace would differ in organization, team AND collection, so a
 * refusal would not say which predicate refused — and would still pass with
 * `teamId` deleted from the `where`, because the organization would have caught
 * it. That is the shape the rule in OPERATIONS.md §7 is about.
 */

let fx: WorkspaceFixture;
let otherTeamId: string;
let collectionId: string;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  const other = await fx.createTeam();
  otherTeamId = other.id;
  const collection = await fx.createCollection();
  collectionId = collection.id;
});

afterAll(async () => {
  await fx.cleanup();
});

const insertSource = async (teamId: string): Promise<string> => {
  const connection = await fx.createConnection();
  const [source] = await db
    .insert(collectionSyncSources)
    .values({
      organizationId: fx.organizationId,
      teamId,
      // The SAME collection as the legitimate source. Only `team_id` differs.
      collectionId,
      kind: "lookup",
      connectionId: connection.id,
      providerKey: connection.providerKey,
      operation: "get_order",
      args: { id: { $field: "reference" } },
      fieldMapping: [{ path: "label", fieldKey: "label" }],
      schedule: { mode: "manual" },
    })
    .returning({ id: collectionSyncSources.id });
  if (source === undefined) throw new Error("fixture: no source");
  return source.id;
};

describe("reads are scoped to the caller's team", () => {
  test("getSyncSource refuses a source of another team in the same collection", async () => {
    const mine = await insertSource(fx.teamId);
    const theirs = await insertSource(otherTeamId);

    expect((await getSyncSource({ id: mine, teamId: fx.teamId }))?.id).toBe(
      mine,
    );
    // Same organization, same collection, same provider, same shape. The only
    // difference is the team — and it must be enough.
    expect(
      await getSyncSource({ id: theirs, teamId: fx.teamId }),
    ).toBeUndefined();
  });

  test("listSyncSources lists only this team's, filtered by collection or not", async () => {
    const mine = await insertSource(fx.teamId);
    await insertSource(otherTeamId);

    const scoped = await listSyncSources({
      teamId: fx.teamId,
      collectionId,
    });
    const all = await listSyncSources({ teamId: fx.teamId });

    expect(scoped.map((source) => source.id)).toContain(mine);
    for (const source of [...scoped, ...all]) {
      const row = await db.query.collectionSyncSources.findFirst({
        where: { id: source.id },
        columns: { teamId: true },
      });
      expect(row?.teamId).toBe(fx.teamId);
    }
  });

  test("listSyncRuns refuses a run row whose team is not the caller's", async () => {
    const source = await insertSource(fx.teamId);
    // A run of MY source, stamped with the other team — the one row shape that
    // can only be refused by the run's own `team_id` predicate.
    await db.insert(collectionSyncRuns).values([
      { syncSourceId: source, teamId: fx.teamId, trigger: "manual" },
      { syncSourceId: source, teamId: otherTeamId, trigger: "manual" },
    ]);

    const mine = await listSyncRuns({
      syncSourceId: source,
      teamId: fx.teamId,
    });
    const theirs = await listSyncRuns({
      syncSourceId: source,
      teamId: otherTeamId,
    });

    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);
  });

  test("a run of another team's source is invisible even by its own id", async () => {
    const theirs = await insertSource(otherTeamId);
    await db.insert(collectionSyncRuns).values({
      syncSourceId: theirs,
      teamId: otherTeamId,
      trigger: "schedule",
    });

    expect(
      await listSyncRuns({ syncSourceId: theirs, teamId: fx.teamId }),
    ).toEqual([]);
  });
});
