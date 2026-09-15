import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Who has already been shown which product update.
 *
 * The updates THEMSELVES are not here. They live as reviewed files in the
 * frontend repo (`app/changelog/entries/<slug>/`), because the thing that has
 * to happen before a user-facing announcement goes out is a human reading it —
 * and a pull request already is that, with a preview deployment attached. A
 * table would have bought a draft/publish state machine, an admin UI to drive
 * it, and a second place where the text can be wrong. See
 * `CHANGELOG-AUTHORING.md` in the frontend repo.
 *
 * What a table DOES buy, and the only reason this one exists:
 *
 *  - **"Seen" follows the person, not the browser.** The obvious
 *    implementation is `localStorage`, and it re-announces the same update to
 *    the same person on their laptop, their desktop, a private window and
 *    every cleared cache. For a B2B tool where one account is one professional
 *    working from two machines, that is the common case and not the edge.
 *  - **Adoption is measurable.** `select count(*) from changelog_reads where
 *    slug = ?` answers "did anyone actually notice the feature we shipped",
 *    which is the question that decides whether the next one is worth
 *    building. `changelog_reads_slug_idx` is there for exactly that read.
 *
 * `slug` carries NO foreign key and no enum: its referent is a directory in
 * another repository, deployed on its own schedule. A row for an entry that
 * was renamed or removed is harmless — it matches nothing and the person sees
 * the update once more at worst — whereas a constraint here would mean the API
 * could refuse a write because the frontend shipped first.
 *
 * Rows are never deleted except with the user (`on delete cascade`).
 */
export const changelogReads = pgTable(
  "changelog_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** The entry's directory name in the frontend repo, e.g.
     * `2026-09-15-record-relations`. */
    slug: varchar("slug", { length: 128 }).notNull(),

    seenAt: timestamp("seen_at", { mode: "date", withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // The natural key IS the row: marking an entry seen is an idempotent
    // `onConflictDoNothing`, and the leading `user_id` serves the one read the
    // app makes on boot ("which slugs has this person already seen").
    primaryKey({
      name: "changelog_reads_pk",
      columns: [table.userId, table.slug],
    }),
    // Reach per entry — the adoption metric. The primary key is led by
    // `user_id` and cannot serve `WHERE slug = ?`.
    index("changelog_reads_slug_idx").on(table.slug),
  ],
);

export type ChangelogRead = typeof changelogReads.$inferSelect;
export type NewChangelogRead = typeof changelogReads.$inferInsert;
