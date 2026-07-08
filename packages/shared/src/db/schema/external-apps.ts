import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * External apps — connections to third-party SaaS (Outlook, Gmail, …) via
 * Nango. The provider catalogue itself (which apps exist, which actions, their
 * endpoints) is NOT in the database — it lives as YAML manifests under
 * `src/external-apps/providers/<key>/manifest.yaml`, loaded into a registry
 * at boot. The DB only stores per-tenant connections.
 *
 * The write-action approval gate these connections feed lives in the generic
 * `approvals` schema (`./approvals`) — external-app plans are one approval
 * kind among several (record writes, questions).
 */

/**
 * Lifecycle of a connection.
 *  - `active`   : usable.
 *  - `disabled` : turned off by the team in the settings UI (kept, not deleted).
 *  - `error`    : a Nango Proxy call returned 401/403 — token revoked/expired.
 *                 Detected lazily (no webhooks on Nango free self-hosted);
 *                 the frontend offers a "Reconnect" action.
 */
export const externalAppConnectionStatusEnum = pgEnum(
  "external_app_connection_status",
  ["active", "disabled", "error"],
);

/**
 * One connection to an external app for one tenant.
 *
 * Scope is team OR user:
 *  - `user_id` NULL  → team-scoped: every member of the team may use it.
 *  - `user_id` set   → user-scoped: only that user may use it (a personal
 *                      mailbox connected inside a shared team).
 *
 * A team can hold several connections for the same provider with distinct
 * `display_name`s (e.g. an "Ops mailbox" and a "Billing mailbox").
 */
export const externalAppConnections = pgTable(
  "external_app_connections",
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

    /** NULL = team-scoped, set = user-scoped. */
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),

    /** Provider key from the manifest registry, e.g. `outlook`. */
    providerKey: varchar("provider_key", { length: 64 }).notNull(),

    /** Human label chosen at creation, e.g. "Ops mailbox". */
    displayName: varchar("display_name", { length: 128 }).notNull(),

    /** Identifiers of the Nango connection backing this row. */
    nangoConnectionId: varchar("nango_connection_id", {
      length: 128,
    }).notNull(),
    nangoProviderConfigKey: varchar("nango_provider_config_key", {
      length: 64,
    }).notNull(),

    status: externalAppConnectionStatusEnum("status")
      .notNull()
      .default("active"),

    /**
     * Per-provider runtime options, validated dynamically against the
     * provider's `connectionOptions` descriptor. Examples: communication
     * providers (Outlook, IMAP/SMTP, future Slack/Teams/WhatsApp) carry a
     * `persona: "personal" | "bot"` option that drives how the chatbot
     * writes messages on this connection's behalf.
     *
     * NULL when the provider has no `connectionOptions` descriptor. When
     * the descriptor exists, validation happens at the application
     * boundary (POST/PATCH handlers) — no DB-level enforcement.
     */
    options: jsonb("options").$type<Record<string, unknown>>(),

    /** Last Nango/provider error surfaced to the user (set with `error`). */
    lastErrorMessage: text("last_error_message"),

    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => user.id),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // A Nango connection maps to exactly one row.
    uniqueIndex("uniq_eac_nango").on(
      t.nangoConnectionId,
      t.nangoProviderConfigKey,
    ),
    index("idx_eac_team_provider").on(t.teamId, t.providerKey),
    index("idx_eac_user_provider").on(t.userId, t.providerKey),
  ],
);

export type ExternalAppConnection = typeof externalAppConnections.$inferSelect;
export type NewExternalAppConnection =
  typeof externalAppConnections.$inferInsert;
export type ExternalAppConnectionStatus = ExternalAppConnection["status"];
