import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { objectTypes } from "./object-types";

/**
 * Action types — SKELETON (no runtime behavior in V1). The catalog of governed
 * mutations ("verbs": validate_invoice, close_contract) that workflows and the
 * agent will eventually invoke. The table lands now so the migration footprint
 * is paid once; nothing executes these (`enabled` defaults false).
 */
export const actionTypes = pgTable(
  "action_types",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    objectTypeId: uuid("object_type_id")
      .notNull()
      .references(() => objectTypes.id, { onDelete: "cascade" }),

    key: varchar("key", { length: 60 }).notNull(),
    label: text("label").notNull(),
    description: text("description"),

    // RESERVED — param shape for AI/workflow callers (validated at invoke time
    // once execution lands).
    inputSchema: jsonb("input_schema")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    enabled: boolean("enabled").notNull().default(false),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("action_types_type_key_uniq").on(table.objectTypeId, table.key),
    index("action_types_org_idx").on(table.organizationId),
    index("action_types_team_idx").on(table.teamId),
  ],
);

export type ActionType = typeof actionTypes.$inferSelect;
export type NewActionType = typeof actionTypes.$inferInsert;
