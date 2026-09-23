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
  SyncStopReason,
  TableWalkCheckpoint,
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
 * What a source owns — WHOSE the rows are. The one question that cannot be
 * derived, because it decides what an orphan is and what may be deleted.
 *
 *  - `table`   : the source owns the COLLECTION. One upstream row (an order,
 *                a contact) becomes one record, keyed by `externalIdPath`. The
 *                user adds local fields — a formula, a relation, a note —
 *                alongside the synced ones, and those survive every run.
 *  - `columns` : the source owns SOME COLUMNS of a collection the team owns.
 *                It never creates or deletes a record; a row it cannot match
 *                is counted and ignored.
 *
 * HOW the app is read is a second, orthogonal question, and it is DERIVED
 * rather than stored (`syncReadStrategy`): a source whose arguments bind
 * `{"$field"}` is read one call per record, and any other is read by walking
 * the action's list. A `table` source is always walked. Deriving it is what
 * keeps the two from drifting apart — there is no state to contradict the
 * arguments.
 */
export const collectionSyncKindEnum = pgEnum("collection_sync_kind", [
  "table",
  "columns",
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
    // A person pressed Refresh, or the agent called `manageSync refresh`.
    "manual",
    // A record changed and a per-record `columns` source reads a changed field.
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
  // The last attempt for this row failed (a `columns` call that errored).
  "error",
  // `table`: the upstream row is gone. `columns`: the app had no row for this
  // record — either its key resolved to nothing, so no call was made, or a
  // complete walk went by without matching it. Not an error, and not retried
  // until the record changes.
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

    /** Read action name, e.g. `list_orders`. Never a write. */
    operation: varchar("operation", { length: 120 }).notNull(),
    /** Literal arguments, plus `{"$field":…}` / `{"$since":true}` bindings. */
    args: jsonb("args").$type<SyncArgs>().notNull().default({}),
    /** Dot path to the rows inside the answer, as a page dataset's. */
    resultPath: text("result_path"),

    /**
     * Dot path to the value that KEYS an upstream row.
     *
     * For a `table` source it is the row's own stable id, and it is REQUIRED:
     * without it a run cannot tell an updated row from a new one, and every
     * run would duplicate the whole collection.
     *
     * For a walked `columns` source it is the app side of the match — the
     * value that must equal `matchFieldKey`'s column on a record here.
     */
    externalIdPath: text("external_id_path"),

    /**
     * `columns`, walked — the collection field whose value an upstream row's
     * `externalIdPath` must equal for the row to land on that record.
     *
     * Its presence is what makes a `columns` source walkable: with it the app
     * is read a PAGE at a time and matched locally, without it the only way
     * left is one call per record through a `{"$field"}` binding. Exactly one
     * of the two, enforced at both doors.
     *
     * Immutable, like `externalIdPath` and `kind`: it decides which record an
     * answer belongs to, so changing it under a filled collection would
     * re-point every column at once.
     */
    matchFieldKey: varchar("match_field_key", { length: 120 }),

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

    /**
     * A walk frozen mid-flight, so the next leg resumes instead of re-asking
     * for page one. Typed by `TableWalkCheckpoint`; cleared the moment the walk
     * completes, so a non-null value means "a run is part way through".
     *
     * In the database rather than in the BullMQ job on purpose: the job lives
     * in Redis and the walk it belongs to may span hours and a deploy, while
     * the position it holds is worth exactly as much as the source row it
     * describes.
     */
    walkCheckpoint: jsonb("walk_checkpoint").$type<TableWalkCheckpoint>(),

    /**
     * When a run refused to orphan too much of the collection at once.
     *
     * The floor's whole point (see `SYNC_LIMITS.orphanFloorRatio`): an upstream
     * filter narrowing and a collection being emptied are the same answer, so
     * past a threshold the run applies NEITHER `reject` nor `delete`, ends
     * `partial`, and leaves this stamp for the UI and the agent to offer a
     * confirmation against. `keep` is stopped too — a `missing` flood is still
     * a lie about the data.
     */
    fullResyncRequestedAt: timestamp("full_resync_requested_at", {
      withTimezone: true,
    }),
    /** The sentence a person reads before confirming: how many, out of how many. */
    fullResyncReason: text("full_resync_reason"),
    /**
     * Someone said yes. Read by the NEXT run only, which walks everything and
     * applies the policy whatever the floor says, then clears all three.
     */
    fullResyncConfirmedAt: timestamp("full_resync_confirmed_at", {
      withTimezone: true,
    }),

    /**
     * `columns`, per record — how far the "never tracked" scan has walked.
     *
     * Without it the anti-join that finds untracked records is O(collection)
     * on every run once they are all tracked, which is exactly when it finds
     * nothing. The cursor makes the scan a bounded forward walk that finishes
     * and stays finished (`untracked_scan_done_at`) until the daily rescan.
     */
    untrackedScanCursor: uuid("untracked_scan_cursor"),
    untrackedScanDoneAt: timestamp("untracked_scan_done_at", {
      withTimezone: true,
    }),

    /**
     * `table` — when every row was last walked, not just the changed ones.
     *
     * An incremental read cannot be diffed for orphans: "not in the answer"
     * means "did not change", not "gone". So a source that reads incrementally
     * still walks the whole list every `SYNC_LIMITS.fullWalkIntervalMinutes`,
     * and only THAT run brackets the orphans.
     */
    lastFullWalkAt: timestamp("last_full_walk_at", { withTimezone: true }),

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
     * `columns` — records the app had no answer for. NOT a failure: a company
     * that does not exist upstream is the normal case, and counting it here
     * rather than in `failed_count` is what keeps a healthy run green while
     * still saying how many rows came back empty.
     */
    missingCount: integer("missing_count").notNull().default(0),
    /**
     * `columns`, walked — upstream rows that matched no record here.
     *
     * The mirror image of `missing_count`, and it is not a problem either: a
     * source filling three columns of the team's 200 clients from an app that
     * holds 5 000 is SUPPOSED to leave 4 800 unmatched. What it is for is the
     * one number that tells a wrong match column from a right one — a run
     * where every row is unmatched means the key does not line up, which the
     * preview's `matched` should have said first.
     */
    unmatchedCount: integer("unmatched_count").notNull().default(0),
    /**
     * Calls actually made to the third party. The number that tells a team
     * whether its cadence is affordable, and the only one they can act on.
     */
    upstreamCalls: integer("upstream_calls").notNull().default(0),
    /** A bound was reached (`rowCap`, the call budget, the run deadline). */
    truncated: boolean("truncated").notNull().default(false),
    /**
     * Continuations this run took. One walk is ONE run however many legs it
     * needs, so a first load of 300 000 rows reads as one entry in the history
     * with `legs: 7` rather than seven runs nobody can tell apart.
     */
    legs: integer("legs").notNull().default(1),
    /** Which bound bit, when one did. Free text in SQL, a union in TypeScript. */
    stopReason: text("stop_reason").$type<SyncStopReason>(),

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
 * It is also the work queue for per-record `columns` sources: "oldest
 * `synced_at` first" is one indexed read.
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
