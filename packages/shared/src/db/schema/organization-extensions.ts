import {
  boolean,
  decimal,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Extension table for organizations (organizations)
 * Adds quotas and configuration without modifying the Better-Auth organization table
 */
export const organizationSettings = pgTable("organization_settings", {
  // PK is also FK to organization
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),

  // Quotas
  storageQuotaGb: integer("storage_quota_gb").default(100).notNull(),
  maxAgencies: integer("max_agencies").default(10).notNull(),

  // Object type key that parties extracted from uploaded documents are folded
  // into (the document→graph "mentions" target). NULL falls back to `company`
  // for back-compat. Decoupled from a hardcoded `company` so a team can point
  // extraction at any type, and deleting `company` degrades gracefully.
  documentMentionTargetTypeKey: varchar("document_mention_target_type_key", {
    length: 60,
  }),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * Extension table for teams (agencies)
 * Adds API keys and storage tracking
 */
export const teamSettings = pgTable("team_settings", {
  // PK is also FK to team
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),

  // API Authentication
  apiKeyHash: text("api_key_hash").unique(),

  // Per-team bot user used as the `createdById` / `uploadedById` audit value
  // for records created by the workflow engine (SaaS nodes: document upload,
  // extraction launch, folder create, …). Created automatically by the
  // Better Auth `afterCreateTeam` hook; backfilled for existing teams by the
  // migration that introduces this column. `onDelete: "restrict"` prevents
  // the bot user from ever being hard-deleted while a team still references
  // it. Lives here (and not on the Better Auth `team` table) so Fretik can
  // evolve this column without conflicting with upstream auth migrations.
  botUserId: uuid("bot_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),

  // Storage tracking
  storageUsedGb: decimal("storage_used_gb", { precision: 10, scale: 4 })
    .default("0")
    .notNull(),

  lang: varchar("lang", { length: 8 }).default("en").notNull(),

  // Status
  isActive: boolean("is_active").default(true).notNull(),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Type inference
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type NewOrganizationSettings = typeof organizationSettings.$inferInsert;
export type TeamSettings = typeof teamSettings.$inferSelect;
export type NewTeamSettings = typeof teamSettings.$inferInsert;
