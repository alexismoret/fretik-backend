import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  SyncArgs,
  SyncFieldMapping,
  SyncSchedule,
} from "../../schemas/collection-sync";
import { organization, team, user } from "./auth-schema";
import { collectionRecords } from "./collection-records";
import { collections } from "./collections";
import { externalAppConnections } from "./external-apps";

/**
 * Collection sync — the declarative bridge between a connected app and the
 * workspace's own typed columns.
 *
 * THE ONE DECISION THIS SCHEMA ENCODES: an external value lands in an ORDINARY
 * column of `data.coll_<id>`, with the physical type of its field. Not a new
 * field type, not a jsonb bag, not a federated view. Everything the collection
 * system already does — `GENERATED … STORED` formulas over the value, the
 * literal-cast filters, the on-demand `(_team_id, _status, col)` indexes, the
 * rollups, the RLS the SQL tool reads through, the page datasets — then applies
 * to it for free. That is the whole reason this is a sync engine and not a
 * query federator: every product that kept third-party columns LIVE
 * (Salesforce Connect, Power BI DirectQuery) had to forbid formulas,
 * aggregates and server-side sorting on them. See `docs/EXTERNAL-DATA-COLUMNS.md`.
 *
 * What these tables add on top is provenance and scheduling: which app fills
 * which columns, with which arguments, how often, what happened last time, and
 * which rows are up to date.
 */

/**
 * What a source owns.
 *
 *  - `table`  : the source owns the COLLECTION. One upstream row (a shipment,
 *               a contact) becomes one record, keyed by `externalIdPath`. The
 *               user adds local fields — a formula, a relation, a note —
 *               alongside the synced ones, and those survive every run.
 *  - `lookup` : the source owns SOME COLUMNS of an existing collection. The
 *               arguments are resolved per record from its own values
 *               (`{"$field": "siret"}`), so the collection keeps its own
 *               identity and lifecycle and only the mapped columns are filled.
 */
export const collectionSyncKindEnum = pgEnum("collection_sync_kind", [
  "table",
  "lookup",
]);

/**
 * What happens to a record whose upstream row has disappeared (`table` only).
 *
 * `keep` is the default, and deliberately not what Airtable and Coda do (they
 * delete). Our records can carry LOCAL fields, links and approvals that the
 * upstream system never knew about, so deleting on a row's absence throws away
 * work the user did — and an upstream filter change looks exactly like a
 * deletion. `keep` marks the row `missing` in `record_sync_state` and leaves it
 * alone; `reject` flips its ontology status so it drops out of the default
 * views while staying in the journal; `delete` is the opt-in destructive one.
 */
export const collectionSyncOrphanPolicyEnum = pgEnum(
  "collection_sync_orphan_policy",
  ["keep", "reject", "delete"],
);

/** Terminal state of one sync run. `partial` = rows landed AND rows failed. */
export const collectionSyncRunStatusEnum = pgEnum(
  "collection_sync_run_status",
  ["running", "success", "partial", "failed", "cancelled"],
);

/** What asked for this run — shown in the run list so a surprise has a cause. */
export const collectionSyncRunTriggerEnum = pgEnum(
  "collection_sync_run_trigger",
  [
    // The source's own interval.
    "schedule",
    // A person pressed Refresh, or the agent called `refreshSync`.
    "manual",
    // A record changed and a `lookup` source reads one of the changed fields.
    "event",
    // Someone opened the collection and the data was older than the source's
    // `refreshOnOpenAfterMinutes`.
    "open",
    // The first run, fired by creating the source.
    "initial",
  ],
);

/** Per-record freshness against ONE source. */
export const recordSyncStatusEnum = pgEnum("record_sync_status", [
  "ok",
  // The last attempt for this row failed (a `lookup` whose call errored).
  "error",
  // `table`: the upstream row is gone. `lookup`: the record has no value for
  // the key the arguments need, so no call was made — which is not an error,
  // and must not be retried until the record changes.
  "missing",
  // Enqueued for a refresh that has not run yet.
  "pending",
]);

/**
 * One declaration: "these columns of this collection are filled by this action
 * of this connected app".
 */
export const collectionSyncSources = pgTable(
  "collection_sync_sources",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),

    kind: collectionSyncKindEnum("kind").notNull(),

    /**
     * The connection this source reads through. `set null` rather than
     * `cascade` on purpose: disconnecting an app must not delete the data it
     * brought, nor the mapping that would let a reconnect resume. A source with
     * no connection stops running and says why.
     */
    connectionId: uuid("connection_id").references(
      () => externalAppConnections.id,
      { onDelete: "set null" },
    ),
    /**
     * Kept alongside `connectionId` — it is what the UI needs to draw the app's
     * icon and name after the connection row is gone, and what a reconnect
     * resolves against.
     */
    providerKey: varchar("provider_key", { length: 64 }).notNull(),

    /** Read action name, e.g. `list_shipments`. Never a write. */
    operation: varchar("operation", { length: 120 }).notNull(),
    /** Literal arguments, plus `{"$field":…}` / `{"$since":true}` bindings. */
    args: jsonb("args").$type<SyncArgs>().notNull().default({}),
    /** Dot path to the rows inside the answer, as a page dataset's. */
    resultPath: text("result_path"),

    /**
     * `table` only — dot path to the upstream row's stable id. REQUIRED for a
     * table source: without it a run cannot tell an updated row from a new one,
     * and every run would duplicate the whole collection.
     */
    externalIdPath: text("external_id_path"),

    /** `[{ path, fieldKey }]` — which upstream value fills which column. */
    fieldMapping: jsonb("field_mapping")
      .$type<SyncFieldMapping[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    schedule: jsonb("schedule")
      .$type<SyncSchedule>()
      .notNull()
      .default({ mode: "manual" }),

    orphanPolicy: collectionSyncOrphanPolicyEnum("orphan_policy")
      .notNull()
      .default("keep"),

    /** `table` only — hard ceiling on rows pulled in one run. */
    rowCap: integer("row_cap").notNull().default(20000),

    /** The user's switch. A disabled source keeps its data and its mapping. */
    enabled: boolean("enabled").notNull().default(true),

    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /**
     * Drives the backoff and the auto-pause. A source whose app has been
     * answering 401 for a day should stop asking — the same reasoning as the
     * workflow circuit breaker, and the reason the page path never flips a
     * connection to `error`: one team's broken credential must not look like
     * an outage.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    /**
     * When the sweep should next pick this source up. THE SCHEDULING MODEL:
     * one minute-ly sweep claims due sources, exactly as
     * `workflow-trigger-sweep` claims due events. Not one repeatable job per
     * source — those live in Redis, and a source's schedule belongs in the
     * database that already owns the source. A flushed Redis then costs a
     * cycle, not a silently dead sync.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * Claim stamp. A sweep sets it when it enqueues the source and the runner
     * clears it when the run ends, so two replicas cannot double-enqueue and a
     * crashed runner is reclaimed after `SYNC_CLAIM_TIMEOUT_MS`.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("collection_sync_sources_collection_idx").on(t.collectionId),
    index("collection_sync_sources_team_idx").on(t.teamId),
    index("collection_sync_sources_connection_idx").on(t.connectionId),
    // The sweep's only query: due, enabled, unclaimed. Partial so it stays
    // small however many sources exist — a manual-mode source has no
    // `next_run_at` at all and never enters this index.
    index("collection_sync_sources_due_idx")
      .on(t.nextRunAt)
      .where(sql`enabled AND next_run_at IS NOT NULL`),
    // A collection has at most ONE table source: two would fight over the same
    // rows, and "which one owns this record" would have no answer.
    uniqueIndex("collection_sync_sources_table_uniq")
      .on(t.collectionId)
      .where(sql`kind = 'table'`),
  ],
);

/**
 * One run, so "why is this figure from yesterday" has an answer that is not a
 * log line. Retention: the latest 20 per source, trimmed post-insert — the
 * same strategy as `page_versions` and `ai_memory_history`.
 */
export const collectionSyncRuns = pgTable(
  "collection_sync_runs",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    syncSourceId: uuid("sync_source_id")
      .notNull()
      .references(() => collectionSyncSources.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    status: collectionSyncRunStatusEnum("status").notNull().default("running"),
    trigger: collectionSyncRunTriggerEnum("trigger").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    /** Rows whose hash was identical — no write, no journal entry, no re-embed. */
    unchangedCount: integer("unchanged_count").notNull().default(0),
    orphanCount: integer("orphan_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /**
     * Calls actually made to the third party. The number that tells a team
     * whether its cadence is affordable, and the only one they can act on.
     */
    upstreamCalls: integer("upstream_calls").notNull().default(0),
    /** A bound was reached (`rowCap`, the call budget, the run deadline). */
    truncated: boolean("truncated").notNull().default(false),

    error: text("error"),
    /** Who pressed Refresh, when a person did. */
    triggeredByUserId: uuid("triggered_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("collection_sync_runs_source_started_idx").on(
      t.syncSourceId,
      t.startedAt,
    ),
    index("collection_sync_runs_team_idx").on(t.teamId, t.startedAt),
  ],
);

/**
 * Per-record, per-source freshness — the table that makes a sync cheap.
 *
 * `contentHash` is what turns "read 10 000 rows" into "write the 12 that
 * changed": an identical hash skips the UPDATE, and skipping the UPDATE skips
 * the `domain_events` row, which skips the record-card re-embedding and the
 * workflow trigger sweep. Without it an hourly sync of a large collection would
 * re-embed the whole thing every hour and fire a workflow run per row.
 *
 * It is also the work queue for `lookup` sources: "oldest `synced_at` first"
 * is one indexed read.
 */
export const recordSyncState = pgTable(
  "record_sync_state",
  {
    recordId: uuid("record_id")
      .notNull()
      .references(() => collectionRecords.id, { onDelete: "cascade" }),
    syncSourceId: uuid("sync_source_id")
      .notNull()
      .references(() => collectionSyncSources.id, { onDelete: "cascade" }),

    status: recordSyncStatusEnum("status").notNull().default("ok"),
    /** sha256 of the projected values, truncated — a change detector, not a key. */
    contentHash: varchar("content_hash", { length: 64 }),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),

    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.syncSourceId] }),
    // "What should I refresh next" — stalest first, within one source.
    index("record_sync_state_source_synced_idx").on(t.syncSourceId, t.syncedAt),
    index("record_sync_state_source_status_idx").on(t.syncSourceId, t.status),
  ],
);

export type CollectionSyncSource = typeof collectionSyncSources.$inferSelect;
export type NewCollectionSyncSource = typeof collectionSyncSources.$inferInsert;
export type CollectionSyncRun = typeof collectionSyncRuns.$inferSelect;
export type NewCollectionSyncRun = typeof collectionSyncRuns.$inferInsert;
export type RecordSyncState = typeof recordSyncState.$inferSelect;
export type CollectionSyncKind = CollectionSyncSource["kind"];
export type CollectionSyncOrphanPolicy = CollectionSyncSource["orphanPolicy"];
export type CollectionSyncRunStatus = CollectionSyncRun["status"];
export type CollectionSyncRunTrigger = CollectionSyncRun["trigger"];
export type RecordSyncStatus = RecordSyncState["status"];
