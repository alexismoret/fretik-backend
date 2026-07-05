import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Named consumption cursors over the `domain_events` journal (uuid v7 ids are
 * time-ordered, so a plain id is a position). One row per consumer — the
 * memory-resolver sweep today, the future workflow trigger engine tomorrow —
 * each advancing independently. Global infra state: no org/team scoping, no
 * SQL-tool visibility (RLS enabled with no policy).
 */
export const workerCursors = pgTable("worker_cursors", {
  name: text("name").primaryKey(),
  // Last consumed domain_events.id (exclusive lower bound of the next sweep).
  position: uuid("position").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type WorkerCursor = typeof workerCursors.$inferSelect;
export type NewWorkerCursor = typeof workerCursors.$inferInsert;
