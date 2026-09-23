import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { team, user } from "./auth-schema";

/** Who wrote a folder's description: the nightly generator (`auto`), a person
 * (`manual`), or the assistant at someone's request (`agent`). Only `auto` is
 * ever regenerated — the other two state an intent, which outranks anything
 * inferred from what the folder already holds. A `varchar` rather than a
 * pgEnum, so adding a writer costs no migration. */
export type FolderDescriptionSource = "auto" | "manual" | "agent";

/**
 * Folders for organizing documents hierarchically
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Team ownership
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Hierarchy (self-reference)
    parentFolderId: uuid("parent_folder_id"),

    // Folder name
    name: text("name").notNull(),

    // Full path for fast queries (e.g., "/root/subfolder/current")
    fullPath: text("full_path").notNull(),

    /**
     * What this folder is FOR, in one or two sentences.
     *
     * It exists because a file with no destination has to be filed somewhere,
     * and a folder name alone rarely says enough to choose between "Clients"
     * and "Contracts". Almost nobody writes one by hand, so the nightly pass
     * derives it from the documents already inside — the extraction summaries
     * are in `document_properties` already, so it costs one cheap call per
     * folder and no re-reading of a single file.
     */
    description: text("description"),
    /**
     * `manual` once a person has edited it, and then the generator NEVER
     * touches it again. A description someone wrote is a statement of intent
     * about where things should go; regenerating over it would silently undo
     * the one signal worth more than anything inferred.
     */
    descriptionSource: varchar("description_source", {
      length: 10,
    }).$type<FolderDescriptionSource>(),
    descriptionGeneratedAt: timestamp("description_generated_at", {
      withTimezone: true,
    }),
    /**
     * `documentCount` at generation time — the drift measure. A folder that
     * has gained a dozen documents since may have changed what it is for, and
     * a description that outlives its folder's purpose files things wrongly
     * with complete confidence.
     */
    descriptionDocumentCount: integer("description_document_count"),

    // Created by
    createdById: uuid("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),

    // Stats
    subFolderCount: integer("sub_folder_count").default(0).notNull(),
    documentCount: integer("document_count").default(0).notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentFolderId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    index("folders_team_idx").on(table.teamId),
    index("folders_parent_idx").on(table.parentFolderId),
    index("folders_full_path_idx").on(table.fullPath),
  ],
);

// Self-reference for parent folder (added after table definition)
// This will be handled in relations.ts

// Type inference
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
