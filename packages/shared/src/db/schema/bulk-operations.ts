import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { toolApprovalRequests } from "./approvals";
import { organization, team, user } from "./auth-schema";

/**
 * What kind of work a bulk operation performs. A `text` column with a TS union,
 * for the same reason `CONVERSATION_TASK_KINDS` is one: a new kind must be an
 * executor module plus one line here, never a DDL migration. Only kinds that
 * HAVE an executor are listed — an unimplemented kind in this union would be a
 * registry hole that only fails at runtime.
 */
export const BULK_OPERATION_KINDS = ["record_import"] as const;
export type BulkOperationKind = (typeof BULK_OPERATION_KINDS)[number];

/**
 * Lifecycle of one bulk operation.
 *
 *  - `staging`          : accepting chunks. In `direct` mode each chunk is also
 *                         APPLIED as it lands; in `staged` mode chunks only
 *                         accumulate, awaiting a grant.
 *  - `pending_approval` : every chunk is in, a human is deciding.
 *  - `queued` / `running` : granted, handed to the worker.
 *  - `done`             : finished, `progress` holds the counters. Terminal and
 *                         REPLAYABLE — a re-run of the same code matches this
 *                         row by `lookup_hash` and gets the counters back
 *                         without re-uploading a single row.
 *  - `failed` / `cancelled` : terminal, `error` says why.
 */
export const BULK_OPERATION_STATUSES = [
  "staging",
  "pending_approval",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type BulkOperationStatus = (typeof BULK_OPERATION_STATUSES)[number];

/**
 * How the operation reaches the database.
 *
 *  - `direct` : the write needs no human grant (team policy `auto`, or an
 *               autonomous run). Each chunk is applied inside the request that
 *               uploads it, so the caller gets its ids back and the operation
 *               never leaves the turn.
 *  - `staged` : a human must grant. Chunks are parked as jsonb, ONE approval
 *               card is opened for the whole load, and the worker drains them
 *               after the grant — which is what lets the user close the tab.
 */
export const BULK_OPERATION_MODES = ["direct", "staged"] as const;
export type BulkOperationMode = (typeof BULK_OPERATION_MODES)[number];

/** Kind-specific static input, frozen at creation. `record_import` today. */
export interface RecordImportParams {
  op: "create";
  collectionId: string;
  collectionKey: string;
}

export type BulkOperationParams = RecordImportParams;

/**
 * Running tally of a drain, merged chunk by chunk.
 *
 * `errors` is capped while `errorCount` keeps counting: a load where every row
 * is malformed must report "180 000 rows failed" without storing 180 000
 * messages, and the first few are enough to show WHY. Indexes are global row
 * numbers (chunkIndex × chunkSize + position), so a reported error points at a
 * line of the caller's original list.
 */
export interface BulkOperationProgress {
  processed: number;
  succeeded: number;
  failed: number;
  errorCount: number;
  errors: { index: number; error: string }[];
}

/** One error line kept per chunk, and the cap on the operation-level list. */
export const BULK_OPERATION_ERROR_LIMIT = 50;

/**
 * ONE bulk load, decoupled from the request that submits it.
 *
 * The problem it exists for: a 200 000-row import cannot travel as one HTTP
 * body, cannot be reviewed row by row, cannot fit in an approval's jsonb
 * payload, and must not die with the browser tab that approved it. So the rows
 * are uploaded in chunks against this row, ONE approval card describes the
 * whole thing, and a worker applies it afterwards.
 *
 * `lookup_hash` is the replay key, the same idea as an approval's: sha256 over
 * the load's stable description (kind + type + row count + a digest of the
 * rows). A re-run of the agent's code recomputes it, matches this row, and gets
 * the outcome back WITHOUT re-uploading — which is what makes the "re-run the
 * exact same code after the grant" contract affordable at this size. It is a
 * dedup key, never an authorization: tenancy stays on the JWT and the grant.
 */
export const bulkOperations = pgTable(
  "bulk_operations",
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
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    /** Sandbox turn that opened the operation — UI correlation only. */
    turnId: varchar("turn_id", { length: 128 }).notNull(),

    kind: text("kind").$type<BulkOperationKind>().notNull(),
    status: text("status")
      .$type<BulkOperationStatus>()
      .notNull()
      .default("staging"),
    mode: text("mode").$type<BulkOperationMode>().notNull(),

    /** Replay key — see the table docblock. */
    lookupHash: varchar("lookup_hash", { length: 64 }).notNull(),

    /** Rows the caller announced. The chunk ledger is checked against it. */
    totalItems: integer("total_items").notNull(),
    /**
     * Rows per chunk, decided SERVER-side from the target type's real column
     * width so one chunk is exactly one database transaction. That equality is
     * load-bearing: it is what lets a failed chunk be retried without risking a
     * half-applied one (see `bulk-operations/chunk.ts`).
     */
    chunkSize: integer("chunk_size").notNull(),

    params: jsonb("params").$type<BulkOperationParams>().notNull(),

    /**
     * The first few rows, verbatim — the evidence the approval card shows. Not
     * a short list of what will be written: proof that the column mapping is
     * right before someone grants 200 000 of them.
     */
    sample: jsonb("sample").$type<Record<string, unknown>[]>().notNull(),
    /** Column names detected by the caller, for the card's header. */
    columns: jsonb("columns").$type<string[]>(),

    /** The card that gates it — `staged` mode only. */
    approvalId: uuid("approval_id").references(() => toolApprovalRequests.id, {
      onDelete: "set null",
    }),

    progress: jsonb("progress").$type<BulkOperationProgress>(),

    /**
     * How many times a `failed` drain was resumed from its ledger.
     *
     * A failed load is resumable — the applied chunks are stamped, so picking
     * it back up writes only what is missing — and that is what the agent's
     * re-run does. The counter is what keeps "resumable" from meaning
     * "retryable forever": an infrastructure hiccup clears on the next
     * attempt, while a cause that is not going away (the column the rows need
     * was dropped, a constraint now refuses them) fails identically every
     * time, and past {@link MAX_BULK_OPERATION_RESUMES} the load is refused
     * with its reason instead of being re-queued on a loop.
     */
    resumeCount: integer("resume_count").notNull().default(0),

    /** Why a terminal `failed` / `cancelled` ended that way. */
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The replay lookup, and the guard that makes creation idempotent: a
    // re-run of the same code inside the same conversation resolves to THIS
    // row instead of opening a second load.
    uniqueIndex("bulk_operations_conversation_hash_uniq").on(
      t.conversationId,
      t.lookupHash,
    ),
    index("bulk_operations_approval_idx").on(t.approvalId),
    // The sweep's read: what is stuck, oldest first.
    index("bulk_operations_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * One chunk of a bulk operation — both its payload and its ledger entry.
 *
 * `items` is present only in `staged` mode (`direct` applies on arrival and has
 * nothing to park). The row is written BEFORE the chunk is applied, so its
 * existence claims the slot; `applied_at` is what says the work is done. That
 * ordering is the exactly-once story:
 *
 *  - row absent            → never started, apply it;
 *  - row present, applied  → skip, its outcome is in `result`;
 *  - row present, attempts > 0 and NOT applied → a process died mid-apply. The
 *    chunk is NOT replayed (that would duplicate records); it is reported. A
 *    clean exception decrements `attempts` back, so only a real crash lands
 *    here.
 */
export const bulkOperationChunks = pgTable(
  "bulk_operation_chunks",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    operationId: uuid("operation_id")
      .notNull()
      .references(() => bulkOperations.id, { onDelete: "cascade" }),

    chunkIndex: integer("chunk_index").notNull(),
    itemCount: integer("item_count").notNull(),

    /** Parked rows — `staged` mode only. */
    items: jsonb("items").$type<Record<string, unknown>[]>(),

    /** Apply attempts started. See the table docblock. */
    attempts: integer("attempts").notNull().default(0),

    appliedAt: timestamp("applied_at", { withTimezone: true }),

    /** Per-chunk outcome: how many rows landed, and the first few failures. */
    result: jsonb("result").$type<{
      succeeded: number;
      failed: number;
      errors: { index: number; error: string }[];
    }>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Makes an upload idempotent: a retried chunk POST is a no-op, not a
    // duplicate load.
    uniqueIndex("bulk_operation_chunks_operation_index_uniq").on(
      t.operationId,
      t.chunkIndex,
    ),
    // The runner's cursor: the next unapplied chunk, in order.
    index("bulk_operation_chunks_pending_idx")
      .on(t.operationId, t.chunkIndex)
      .where(sql`applied_at IS NULL`),
  ],
);

export type BulkOperation = typeof bulkOperations.$inferSelect;
export type NewBulkOperation = typeof bulkOperations.$inferInsert;
export type BulkOperationChunk = typeof bulkOperationChunks.$inferSelect;
