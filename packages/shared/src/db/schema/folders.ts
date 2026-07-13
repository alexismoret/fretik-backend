import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { team, user } from "./auth-schema";

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
