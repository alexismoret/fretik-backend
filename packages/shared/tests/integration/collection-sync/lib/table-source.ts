import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../../src/db";
import type { CollectionSyncSource } from "../../../../src/db/schema";
import { collectionSyncSources } from "../../../../src/db/schema";
import type { SyncReadAction } from "../../../../src/services/collection-sync/resolve-action";
import { createCollectionWithFields } from "../../../../src/services/collections/create-with-fields";
import type { WorkspaceFixture } from "../../../lib/db-fixtures";

/**
 * A real `table` source over a FAKE upstream — the harness the walk, the diff
 * and the orphan bracket are tested through.
 *
 * The collection, its columns, the records and every row of `record_sync_state`
 * are real: those are what the assertions are about. What is faked is the third
 * party, because a test that needed a credential would be testing somebody
 * else's uptime (`OPERATIONS.md` §7).
 */

export interface FakeUpstream {
  /** Every argument map the action was called with, in order. */
  calls: Record<string, unknown>[];
  action: SyncReadAction;
}

export interface UpstreamRow {
  id: string;
  label: string;
  amount: number;
}

export const row = (id: string, amount = 1): UpstreamRow => ({
  id,
  label: `Row ${id}`,
  amount,
});

/**
 * An action that pages by offset, hands back `pages[i]`, and records what it
 * was asked for.
 *
 * `offset`/`limit` are declared as params because the walker refuses to page an
 * action that does not accept the parameter its pagination names — which is the
 * `unpaged` case, and not what these suites are about.
 */
export const offsetUpstream = (
  pages: UpstreamRow[][],
  options: {
    pageSize?: number;
    /**
     * Burn this much wall clock once the given page has been answered.
     *
     * The walker checks its deadline BEFORE each call, against a real
     * `Date.now()`. A test cannot move that clock, and mutating the
     * `deadlineAt` it was handed does nothing — the value is read once, when
     * the walk starts. Making the upstream genuinely slow is the only way to
     * put a walk over its budget at a chosen page, and it is also what really
     * happens: budgets are spent waiting for somebody else.
     */
    stallAfterPage?: number;
    stallMs?: number;
    /** Throw this on the call at the given index, instead of answering. */
    throwOnCall?: { index: number; error: Error };
  } = {},
): FakeUpstream => {
  const calls: Record<string, unknown>[] = [];
  const pageSize = options.pageSize ?? 100;
  return {
    calls,
    action: {
      name: "list_orders",
      params: {
        offset: { type: "number" },
        limit: { type: "number", max: pageSize },
        updated_after: { type: "string" },
      },
      walksItself: false,
      pagination: {
        kind: "offset",
        offsetParam: "offset",
        limitParam: "limit",
      },
      incremental: { param: "updated_after", format: "iso" },
      call: async (args) => {
        const index = calls.length;
        if (options.throwOnCall?.index === index) {
          calls.push(args);
          throw options.throwOnCall.error;
        }
        calls.push(args);
        const answer = { items: pages[index] ?? [] };
        if (options.stallAfterPage === index) {
          await Bun.sleep(options.stallMs ?? 200);
        }
        return answer;
      },
    },
  };
};

/** One page, whatever is asked: the `{items: []}` shape with no pagination. */
export const singlePageUpstream = (rows: UpstreamRow[]): FakeUpstream => {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    action: {
      name: "list_orders",
      params: { updated_after: { type: "string" } },
      walksItself: true,
      incremental: { param: "updated_after", format: "iso" },
      call: async (args) => {
        calls.push(args);
        return Promise.resolve({ items: rows });
      },
    },
  };
};

export interface TableSourceFixture {
  collectionId: string;
  source: CollectionSyncSource;
  /** Re-read the row, so a test asserts what the runner actually wrote. */
  reload: () => Promise<CollectionSyncSource>;
}

/**
 * A collection with `label` and `amount` columns, and a `table` source that
 * owns both.
 *
 * `syncSourceId` is stamped on the field definitions on purpose: `ownedFields`
 * requires BOTH the mapping and the stamp, so a source whose fields were not
 * stamped would silently write nothing and every assertion below would pass
 * against an empty collection.
 */
export const createTableSource = async (
  fx: WorkspaceFixture,
  overrides: Partial<typeof collectionSyncSources.$inferInsert> = {},
): Promise<TableSourceFixture> => {
  const connection = await fx.createConnection();
  const collection = await createCollectionWithFields({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    key: `orders_${randomUUID().slice(0, 8)}`,
    label: "Orders",
    fields: [
      { label: "Label", key: "label", type: "text", isTitle: true },
      { label: "Amount", key: "amount", type: "number" },
    ],
  });

  const [source] = await db
    .insert(collectionSyncSources)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: collection.id,
      kind: "table",
      connectionId: connection.id,
      providerKey: connection.providerKey,
      operation: "list_orders",
      args: {},
      externalIdPath: "id",
      fieldMapping: [
        { path: "label", fieldKey: "label" },
        { path: "amount", fieldKey: "amount" },
      ],
      schedule: { mode: "interval", everyMinutes: 15 },
      rowCap: 100_000,
      ...overrides,
    })
    .returning();
  if (source === undefined) throw new Error("fixture: no sync source");

  // The stamp that makes these columns this source's to write.
  await db.execute(sql`
    UPDATE field_definitions
       SET sync_source_id = ${source.id}::uuid
     WHERE collection_id = ${collection.id}::uuid
       AND key IN ('label', 'amount')`);

  const reload = async (): Promise<CollectionSyncSource> => {
    const fresh = await db.query.collectionSyncSources.findFirst({
      where: { id: source.id },
    });
    if (fresh === undefined) throw new Error("fixture: source vanished");
    return fresh;
  };

  return { collectionId: collection.id, source: await reload(), reload };
};

/**
 * The DATABASE's clock, which is the only one the orphan bracket may be
 * compared against.
 *
 * Not `new Date()`. `walkStartedAt` is measured against
 * `record_sync_state.synced_at`, a Postgres `now()`, and on a host whose clock
 * runs even a second ahead of a containerised database every row a walk just
 * stamped reads as older than the walk — so the walk orphans everything it did.
 * That is exactly what happened the first time this suite ran.
 *
 * The cast to text is load-bearing too: `now()` comes back from the driver as a
 * STRING, so a `value instanceof Date` guard silently falls through to whatever
 * fallback follows it.
 */
export const dbNow = async (): Promise<Date> => {
  const result = await db.execute(sql`SELECT now()::text AS now`);
  const value = Reflect.get(result.rows[0] ?? {}, "now");
  if (typeof value !== "string") throw new Error("fixture: no clock");
  return new Date(value);
};

/** Every record this source owns, with its freshness — the diff's left side. */
export const readTracked = async (
  syncSourceId: string,
): Promise<
  { externalId: string; status: string | null; syncedAt: Date | null }[]
> => {
  const result = await db.execute(sql`
    SELECT r.external_id  AS external_id,
           s.status::text AS status,
           s.synced_at    AS synced_at
      FROM collection_records r
      LEFT JOIN record_sync_state s
             ON s.record_id = r.id
            AND s.sync_source_id = ${syncSourceId}::uuid
     WHERE r.sync_source_id = ${syncSourceId}::uuid
     ORDER BY r.external_id`);
  return result.rows.flatMap((entry) => {
    const externalId = Reflect.get(entry, "external_id");
    if (typeof externalId !== "string") return [];
    const status = Reflect.get(entry, "status");
    const syncedAt = Reflect.get(entry, "synced_at");
    return [
      {
        externalId,
        status: typeof status === "string" ? status : null,
        syncedAt: syncedAt instanceof Date ? syncedAt : null,
      },
    ];
  });
};

/** `record.*` journal entries this source's actor wrote, newest last. */
export const countRecordEvents = async (
  collectionId: string,
  type: string,
): Promise<number> => {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM domain_events e
      JOIN collection_records r ON r.id = e.subject_record_id
     WHERE r.collection_id = ${collectionId}::uuid
       AND e.type = ${type}`);
  const n = Reflect.get(result.rows[0] ?? {}, "n");
  return typeof n === "number" ? n : 0;
};
