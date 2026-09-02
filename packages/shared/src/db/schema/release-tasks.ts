import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The ledger of one-shot jobs that must run ONCE per deployed version.
 *
 * The problem it replaces: a handful of jobs had to happen at every deploy —
 * publishing the edited prompts, auditing the model registry — and the only
 * mechanism was a person remembering. A forgotten `langfuse:seed-prompts`
 * leaves production running the previous prompt while git says otherwise, and
 * nothing anywhere reports the gap.
 *
 * Three services boot from the SAME image, so "once" has to survive three
 * replicas racing and a container restarting. The claim is a single statement
 * (`insert … on conflict (name, version) do update … where`), so exactly one
 * process can win a task, and a row's own state decides whether it is up for
 * grabs at all — see `services/release-tasks/ledger.ts`.
 *
 * Keyed on the deployed VERSION, and that is `GIT_SHA`, never
 * `package.json.version`: `version-bump` commits AFTER the build, so the
 * version inside an image lags by one and two different images can carry the
 * same number.
 *
 * This table is a JOURNAL. Nothing reads it to make a decision except the
 * claim itself, and rows are never deleted — "which deploy published that
 * prompt, and did it work" is the question it exists to answer months later.
 */
export const releaseTasks = pgTable(
  "release_tasks",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    /** Task identity, stable across versions (`langfuse-seed-prompts`). */
    name: varchar("name", { length: 64 }).notNull(),
    /** The deployed `GIT_SHA` (or the package version when running locally). */
    version: varchar("version", { length: 64 }).notNull(),
    /** Which service ran it — `api`, `ai`, `jobs`. */
    service: varchar("service", { length: 8 }).notNull(),

    /**
     * `running` while a process holds the claim, then `ok` or `failed`.
     *
     * `running` is not just bookkeeping: it is the lock. A crashed process
     * leaves one behind, which is why the claim treats a stale `running` as
     * available again rather than as permanently taken.
     */
    outcome: varchar("outcome", { length: 16 })
      .$type<"running" | "ok" | "failed">()
      .notNull(),

    /** Whatever the task chose to report, or the error that stopped it. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),

    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    // The uniqueness that makes "once per version" true, and the target the
    // claim's `on conflict` names.
    uniqueIndex("release_tasks_name_version_idx").on(t.name, t.version),
    index("release_tasks_recent_idx").on(t.startedAt),
  ],
);

export type ReleaseTaskRow = typeof releaseTasks.$inferSelect;
