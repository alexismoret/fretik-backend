import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  decimal,
  index,
  json,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Types of usage metrics tracked
 */
export const metricTypeEnum = pgEnum("metric_type", [
  "documents_processed",
  "storage_gb",
  "api_calls",
]);

/**
 * Types of activity actions logged
 */
export const activityActionEnum = pgEnum("activity_action", [
  "upload",
  "download",
  "delete",
  "config_created",
  "config_updated",
  "folder_created",
  "folder_updated",
  "folder_deleted",
  "label_created",
  "label_updated",
  "label_deleted",
  "export",
]);

/**
 * Types of resources for activity logging
 */
export const resourceTypeEnum = pgEnum("resource_type", [
  "document",
  "folder",
  "label",
]);

/**
 * Webhook event types
 */
export const webhookEventEnum = pgEnum("webhook_event", [
  "document.uploaded",
  "document.processing",
  "document.completed",
  "document.failed",
]);

/**
 * Usage metrics for tracking consumption
 */
export const usageMetrics = pgTable(
  "usage_metrics",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Organization ownership (enterprise level)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    // Optional team for per-agency analytics
    teamId: uuid("team_id").references(() => team.id, { onDelete: "set null" }),

    // Metric info
    metricType: metricTypeEnum("metric_type").notNull(),
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),

    // Period
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    // Timestamp
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("usage_metrics_org_idx").on(table.organizationId),
    index("usage_metrics_team_idx").on(table.teamId),
    index("usage_metrics_type_idx").on(table.metricType),
    index("usage_metrics_period_idx").on(table.periodStart, table.periodEnd),
    index("usage_metrics_org_period_idx").on(
      table.organizationId,
      table.periodStart,
    ),
  ],
);

/**
 * Activity logs for audit trail
 */
export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Team ownership
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Actor
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),

    // Action details
    action: activityActionEnum("action").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    resourceId: uuid("resource_id"),

    // Additional context
    metadata: json("metadata"),

    // Request info
    ipAddress: varchar("ip_address", { length: 45 }), // IPv6 compatible
    userAgent: text("user_agent"),

    // Timestamp
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("activity_logs_team_idx").on(table.teamId),
    index("activity_logs_user_idx").on(table.userId),
    index("activity_logs_action_idx").on(table.action),
    index("activity_logs_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
    index("activity_logs_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Webhooks for external integrations
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Team ownership
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Webhook configuration
    url: text("url").notNull(),
    events: text("events").array().notNull(), // Array of webhook events
    secret: text("secret").notNull(), // HMAC secret for signature

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
  },
  (table) => [
    index("webhooks_team_idx").on(table.teamId),
    index("webhooks_active_idx").on(table.isActive),
  ],
);

// Type inference
export type UsageMetric = typeof usageMetrics.$inferSelect;
export type NewUsageMetric = typeof usageMetrics.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
