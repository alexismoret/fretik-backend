import "@hono/zod-openapi";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { collectionSyncSources } from "../../../src/db/schema";
import { redis } from "../../../src/lib/redis";
import { nudgeSyncSourcesForConnection } from "../../../src/services/collection-sync/nudge-on-notify";
import { createCollectionWithFields } from "../../../src/services/collections/create-with-fields";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * What a relayed provider webhook is allowed to move.
 *
 * Integration because every claim here IS a `where` clause. The nudge is one
 * SELECT and one UPDATE, and what makes it safe rather than a free way for a
 * third party to spend our rate limit is precisely which rows those two
 * statements decline to touch — a unit test with a faked db would assert the
 * predicate I wrote, not the one Postgres runs.
 *
 * The four sources below are the four kinds that can sit on one connection, and
 * exactly one of them may move.
 */

let fx: WorkspaceFixture;
let collectionId: string;
const touchedKeys: string[] = [];

/** Far enough ahead that `next_run_at > now()` holds for the whole suite. */
const IN_AN_HOUR = (): Date => new Date(Date.now() + 60 * 60_000);

const NANGO_PROVIDER = "front";

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  const collection = await createCollectionWithFields({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    key: `nudge_${randomUUID().slice(0, 8)}`,
    label: "Orders",
    fields: [{ label: "Label", key: "label", type: "text", isTitle: true }],
  });
  collectionId = collection.id;
});

afterEach(async () => {
  if (touchedKeys.length > 0) await redis.del(...touchedKeys);
  touchedKeys.length = 0;
  await db.execute(sql`
    DELETE FROM collection_sync_sources
     WHERE collection_id = ${collectionId}::uuid`);
});

afterAll(async () => {
  await fx.cleanup();
});

/** A connection with the Nango pair a delivery arrives under. */
const connectWithNangoRef = async (): Promise<{
  id: string;
  nangoConnectionId: string;
}> => {
  const nangoConnectionId = `conn_${randomUUID().slice(0, 8)}`;
  const connection = await fx.createConnection({
    providerKey: NANGO_PROVIDER,
    nangoConnectionId,
    nangoProviderConfigKey: NANGO_PROVIDER,
  });
  touchedKeys.push(`sync:nudge:${connection.id}`);
  return { id: connection.id, nangoConnectionId };
};

const addSource = async (
  connectionId: string,
  overrides: Partial<typeof collectionSyncSources.$inferInsert>,
): Promise<string> => {
  const [source] = await db
    .insert(collectionSyncSources)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId,
      // `columns` rather than `table` because a collection takes at most ONE
      // `table` source (`collection_sync_sources_table_uniq`), and the cases
      // below need four of them side by side on one connection. The nudge does
      // not read `kind` — it reads the schedule, the claim and the args.
      kind: "columns",
      matchFieldKey: "label",
      connectionId,
      providerKey: NANGO_PROVIDER,
      operation: "list_contacts",
      // Incremental by default — the one shape a notification may accelerate.
      args: { updated_after: { $since: true } },
      externalIdPath: "id",
      fieldMapping: [{ path: "name", fieldKey: "label" }],
      schedule: { mode: "interval", everyMinutes: 60 },
      nextRunAt: IN_AN_HOUR(),
      ...overrides,
    })
    .returning({ id: collectionSyncSources.id });
  if (source === undefined) throw new Error("fixture: no sync source");
  return source.id;
};

const nextRunAtOf = async (sourceId: string): Promise<Date> => {
  const row = await db.query.collectionSyncSources.findFirst({
    where: { id: sourceId },
    columns: { nextRunAt: true },
  });
  if (row?.nextRunAt == null) throw new Error("source has no next_run_at");
  return row.nextRunAt;
};

/**
 * Due NOW — within a few seconds of the statement, in either direction.
 *
 * Bounded on both sides on purpose. The first version tested only
 * `now - at < 5s`, which every FUTURE timestamp also satisfies (the difference
 * is negative), so "was left an hour away" read as "was brought forward" and
 * the suite agreed with itself.
 */
const isDueNow = (at: Date): boolean =>
  Math.abs(Date.now() - at.getTime()) < 5_000;

describe("a notification moves the sources that were going to run anyway", () => {
  test("an incremental scheduled source is brought forward", async () => {
    const connection = await connectWithNangoRef();
    const sourceId = await addSource(connection.id, {});

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: true, sourceIds: [sourceId] });
    expect(isDueNow(await nextRunAtOf(sourceId))).toBe(true);
  });

  test("a source with no `$since` binding is left alone", async () => {
    // A full walk brought forward by every notification spends its whole page
    // budget per burst — the opposite of what a webhook is for. Remove the
    // `syncArgsBindSince` filter and this goes green while the engine starts
    // re-walking a hundred pages on somebody else's schedule.
    const connection = await connectWithNangoRef();
    const before = IN_AN_HOUR();
    const sourceId = await addSource(connection.id, {
      args: { status: "open" },
      nextRunAt: before,
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: false, reason: "no_sources" });
    expect((await nextRunAtOf(sourceId)).getTime()).toBe(before.getTime());
  });

  test("a source the app binds `$since` on deep in its args still counts", async () => {
    // The binding may sit at any depth, which is why the filter is TS and not
    // a `LIKE` over jsonb.
    const connection = await connectWithNangoRef();
    const sourceId = await addSource(connection.id, {
      args: { filter: { range: [{ from: { $since: true } }] } },
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: true, sourceIds: [sourceId] });
  });

  test("a manual source is never woken by the app", async () => {
    // "Only when I ask" means the TEAM. A manual source an app could start is
    // not manual, and nobody is watching for the run it would produce.
    const connection = await connectWithNangoRef();
    const sourceId = await addSource(connection.id, {
      schedule: { mode: "manual" },
      nextRunAt: null,
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: false, reason: "no_sources" });
    const row = await db.query.collectionSyncSources.findFirst({
      where: { id: sourceId },
      columns: { nextRunAt: true },
    });
    expect(row?.nextRunAt).toBeNull();
  });

  test("a claimed source is left to the runner holding it", async () => {
    // Drop `claimed_at IS NULL` and this moves `next_run_at` under a run in
    // flight — which `scheduleNextRun` then overwrites when that run ends, so
    // the nudge is both unsafe and lost.
    const connection = await connectWithNangoRef();
    const before = IN_AN_HOUR();
    const sourceId = await addSource(connection.id, {
      claimedAt: new Date(),
      nextRunAt: before,
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: false, reason: "no_sources" });
    expect((await nextRunAtOf(sourceId)).getTime()).toBe(before.getTime());
  });

  test("a disabled source is not a source", async () => {
    const connection = await connectWithNangoRef();
    const before = IN_AN_HOUR();
    const sourceId = await addSource(connection.id, {
      enabled: false,
      nextRunAt: before,
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: false, reason: "no_sources" });
    expect((await nextRunAtOf(sourceId)).getTime()).toBe(before.getTime());
  });

  test("the four kinds together: only the incremental scheduled one moves", async () => {
    const connection = await connectWithNangoRef();
    const incremental = await addSource(connection.id, {});
    const full = await addSource(connection.id, { args: {} });
    const manual = await addSource(connection.id, {
      schedule: { mode: "manual" },
      nextRunAt: null,
    });
    const claimed = await addSource(connection.id, {
      claimedAt: new Date(),
    });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: true, sourceIds: [incremental] });
    expect(isDueNow(await nextRunAtOf(full))).toBe(false);
    expect(isDueNow(await nextRunAtOf(claimed))).toBe(false);
    const manualRow = await db.query.collectionSyncSources.findFirst({
      where: { id: manual },
      columns: { nextRunAt: true },
    });
    expect(manualRow?.nextRunAt).toBeNull();
  });
});

describe("the debounce is per connection and cluster-wide", () => {
  test("a second delivery within the window does nothing", async () => {
    // An app that fires a webhook per changed record would otherwise turn one
    // busy minute into one run per record, past every cadence the team chose.
    const connection = await connectWithNangoRef();
    const sourceId = await addSource(connection.id, {});

    const first = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });
    expect(first).toMatchObject({ nudged: true });

    // Put it back in the future, so a second nudge would be VISIBLE if it ran.
    const parked = IN_AN_HOUR();
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET next_run_at = ${parked}
       WHERE id = ${sourceId}::uuid`);

    const second = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });
    expect(second).toMatchObject({ nudged: false, reason: "debounced" });
    expect((await nextRunAtOf(sourceId)).getTime()).toBe(parked.getTime());
  });

  test("the window is held per connection, so a second app still gets through", async () => {
    const first = await connectWithNangoRef();
    const second = await connectWithNangoRef();
    const firstSource = await addSource(first.id, {});
    const secondSource = await addSource(second.id, {});

    await nudgeSyncSourcesForConnection({
      nangoConnectionId: first.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });
    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: second.nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({ nudged: true, sourceIds: [secondSource] });
    expect(isDueNow(await nextRunAtOf(firstSource))).toBe(true);
  });
});

describe("a delivery we cannot place", () => {
  test("an unknown Nango pair is ordinary, not an error", async () => {
    // The same Nango environment serves other things, and a connection deleted
    // here keeps its webhook registered upstream for a while.
    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: `conn_${randomUUID().slice(0, 8)}`,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });
    expect(outcome).toMatchObject({
      nudged: false,
      reason: "unknown_connection",
    });
  });

  test("the provider config key is part of the identity", async () => {
    // `uniq_eac_nango` is on the PAIR. Matching on the connection id alone
    // would let one Nango environment's delivery move another's sources.
    const connection = await connectWithNangoRef();
    await addSource(connection.id, {});

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId: connection.nangoConnectionId,
      nangoProviderConfigKey: "some-other-integration",
    });
    expect(outcome).toMatchObject({
      nudged: false,
      reason: "unknown_connection",
    });
  });

  test("a connection the team disabled stays asleep", async () => {
    const nangoConnectionId = `conn_${randomUUID().slice(0, 8)}`;
    const connection = await fx.createConnection({
      providerKey: NANGO_PROVIDER,
      nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
      status: "disabled",
    });
    touchedKeys.push(`sync:nudge:${connection.id}`);
    const before = IN_AN_HOUR();
    const sourceId = await addSource(connection.id, { nextRunAt: before });

    const outcome = await nudgeSyncSourcesForConnection({
      nangoConnectionId,
      nangoProviderConfigKey: NANGO_PROVIDER,
    });

    expect(outcome).toMatchObject({
      nudged: false,
      reason: "connection_disabled",
    });
    expect((await nextRunAtOf(sourceId)).getTime()).toBe(before.getTime());
  });
});
