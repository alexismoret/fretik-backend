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
import type { ExternalAppDescriptor } from "../../schemas/external-app-descriptor";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import { organization, team, user } from "./auth-schema";
import { pages } from "./pages";

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
 * How many calls this ACCOUNT tolerates in flight at once.
 *  - `parallel` : no limit of ours (the default, and free — no lock is taken).
 *  - `serial`   : one at a time, because a call leases something exclusive on
 *                 the far side (a licence seat, a session, a cursor).
 * Mirrors `providerConcurrencySchema` in the manifest; the column overrides it.
 */
export const externalAppConcurrencyModeEnum = pgEnum(
  "external_app_concurrency_mode",
  ["parallel", "serial"],
);

/**
 * How a direct-transport MCP connection authenticates to its server. NULL on a
 * connection row means "not an MCP connection" (a manifest provider) — this
 * column is the single discriminator for MCP-ness (see `mcp/connection-kind`).
 *
 *  - `none`        : no auth — the server is public. No Nango row.
 *  - `api-key`     : a bearer/custom-header key, stored in the Nango vault
 *                    (`mcp-custom-key` integration, `private-api-bearer`).
 *  - `basic`       : username+password (HTTP Basic), stored in the Nango vault
 *                    (`mcp-custom-basic` integration, `private-api-basic`).
 *  - `nango-oauth` : OAuth handled by Nango (curated `*-mcp` + `mcp-generic`);
 *                    the access token is read via `nango.getConnection` and
 *                    injected as `Authorization: Bearer`.
 *  - `oauth-direct`: reserved — a future in-house OAuth client. Not implemented.
 */
export const externalAppMcpAuthKindEnum = pgEnum("external_app_mcp_auth_kind", [
  "none",
  "api-key",
  "basic",
  "nango-oauth",
  "oauth-direct",
]);

/**
 * Discovery-catalog metadata for an MCP connection, captured at confirm and
 * stored on the row. `verified` drives trust (auto-run reads); the rest is
 * display/link context for the hub.
 */
export interface McpCatalogMeta {
  /** Registry qualified name, e.g. `com.notion/mcp`. */
  qualifiedName?: string;
  homepage?: string;
  categories?: string[];
  /** Official (DNS-verified/curated) server ⇒ reads auto-run (`trust: "curated"`). */
  verified?: boolean;
}

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

    /**
     * Identifiers of the Nango connection backing this row. NULL only for a
     * `none`-auth MCP connection (a public server with no Nango row at all);
     * always set for manifest providers and every Nango-backed MCP kind.
     */
    nangoConnectionId: varchar("nango_connection_id", { length: 128 }),
    nangoProviderConfigKey: varchar("nango_provider_config_key", {
      length: 64,
    }),

    /**
     * MCP connections only — how the direct transport authenticates to the
     * server. NULL ⇔ this is NOT an MCP connection (a manifest provider). This
     * is the single MCP discriminator (`mcp/connection-kind.isMcpConnection`).
     */
    mcpAuthKind: externalAppMcpAuthKindEnum("mcp_auth_kind"),

    /**
     * MCP connections only — the server's Streamable-HTTP endpoint the direct
     * transport POSTs to. Set for every MCP connection created after the
     * direct-transport migration; NULL on a pre-migration MCP row (the
     * resolver rejects it with a "reconnect" error).
     */
    mcpServerUrl: varchar("mcp_server_url", { length: 2048 }),

    /**
     * `api-key` MCP connections only — the HTTP header to carry the key. NULL
     * means the default `Authorization: Bearer <key>`; a value (e.g.
     * `X-Api-Key`) sends the raw key under that header instead.
     */
    mcpApiKeyHeader: varchar("mcp_api_key_header", { length: 128 }),

    /**
     * MCP connections only — the remote transport. `http` (Streamable-HTTP,
     * the default) or `sse`. NULL is read as `http` for rows created before the
     * column existed; the resolver passes it straight to `@ai-sdk/mcp`.
     */
    mcpTransport: varchar("mcp_transport", { length: 16 }),

    /**
     * MCP connections only — the app's logo. Either an Iconify name (`i-…`) or
     * an absolute image URL (registry `iconUrl`, or a Google-favicon URL for a
     * custom server). NULL for manifest providers (their icon lives in the
     * manifest). Rendered on the connection card, in chatbot tool steps, and on
     * approval cards — the one place MCP app identity is persisted.
     */
    iconUrl: varchar("icon_url", { length: 2048 }),

    /**
     * MCP connections only — a one-line description of the app (from the
     * discovery catalog). NULL for manifest providers (theirs is in the
     * manifest). Shown in the hub detail and as card context.
     */
    description: text("description"),

    /**
     * MCP connections only — discovery-catalog metadata captured at confirm.
     * `verified` is the trust signal that decides whether this server's reads
     * auto-run (introspection maps it to `trust: "curated"`) vs gate; the rest
     * is display context for the hub. NULL for manifest providers and custom
     * servers added by raw URL.
     */
    catalogMeta: jsonb("catalog_meta").$type<McpCatalogMeta>(),

    /**
     * MCP connections only — fingerprint of the tool snapshot this connection
     * currently uses (`external_app_tool_snapshots.fingerprint`). NULL for
     * manifest providers, and for an MCP connection still being introspected
     * (the UI reads NULL as "preparing"). Bumped when drift is adopted.
     */
    toolFingerprint: varchar("tool_fingerprint", { length: 64 }),

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

    /**
     * Per-action permission policy for THIS connection — a sparse map keyed by
     * action name → level (`auto | approval | blocked`). Absent key falls back
     * to the action's manifest default (`kind: "read"` → `auto`,
     * `"write"` → `approval`). NULL = every action at its default.
     *
     * Edited by the connection's controller: team admins for a team-scoped
     * connection, the owner for a personal one. Resolved at dispatch on the
     * concrete connection the call targets (`services/tool-policies/resolve`).
     */
    actionPolicies:
      jsonb("action_policies").$type<Record<string, ToolPolicyLevel>>(),

    /**
     * Override the provider's declared concurrency for THIS account.
     * NULL = follow the manifest (`concurrency.mode`, default `parallel`).
     *
     * Two things need it. An MCP connection has no manifest at all, so this is
     * the only way to tame a server that cannot take two calls at once. And the
     * same provider is not the same everywhere — one customer's Xtent has five
     * licence seats where another has one, and only the operator knows which.
     */
    concurrencyMode: externalAppConcurrencyModeEnum("concurrency_mode"),

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
    // A Nango connection maps to exactly one row. Postgres NULLS DISTINCT
    // (the default) means `none`-auth MCP rows (both columns NULL) never
    // collide with each other, so no partial-index guard is needed.
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
export type ExternalAppConcurrencyMode = NonNullable<
  ExternalAppConnection["concurrencyMode"]
>;

/**
 * Compiled tool surface of an MCP server, produced at connection time by
 * introspecting `tools/list` → classifying → running the deterministic codegen.
 * Holds the descriptor IR plus the generated Python stub and SKILL, so the
 * sandbox bootstrap can materialize them without re-introspecting each turn.
 *
 * Scope:
 *  - curated vendor (`*-mcp`): the tool surface is identical for everyone →
 *    ONE shared row keyed `(provider_key, fingerprint)`, `connection_id` NULL.
 *  - team's own `mcp-generic` server: the surface is private to that server →
 *    keyed `(connection_id, fingerprint)`, `connection_id` set.
 */
export const externalAppToolSnapshots = pgTable(
  "external_app_tool_snapshots",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    /** Nango provider config key, e.g. `notion-mcp` or `mcp-generic`. */
    providerKey: varchar("provider_key", { length: 64 }).notNull(),

    /**
     * Set only for `mcp-generic` custom servers (whose tool list is private to
     * the connection). NULL for curated vendors (shared snapshot).
     */
    connectionId: uuid("connection_id").references(
      () => externalAppConnections.id,
      { onDelete: "cascade" },
    ),

    /** `fingerprintTools(tools)` — content hash of the tool surface. */
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),

    /** The unified descriptor IR (actions, classification, mcpToolName map). */
    descriptor: jsonb("descriptor").$type<ExternalAppDescriptor>().notNull(),

    /** Generated Python stub (`fretik_apps/<key>.py`). */
    sdkPy: text("sdk_py").notNull(),
    /** Generated `SKILL.md`. */
    skillMd: text("skill_md").notNull(),

    /** Set when the one-shot LLM SKILL enrichment has run for this fingerprint. */
    polishedAt: timestamp("polished_at", { mode: "date", withTimezone: true }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Curated vendors: one shared snapshot per (provider, fingerprint).
    uniqueIndex("uniq_eats_curated")
      .on(t.providerKey, t.fingerprint)
      .where(sql`${t.connectionId} IS NULL`),
    // Custom mcp-generic: one snapshot per (connection, fingerprint).
    uniqueIndex("uniq_eats_custom")
      .on(t.connectionId, t.fingerprint)
      .where(sql`${t.connectionId} IS NOT NULL`),
    index("idx_eats_provider").on(t.providerKey),
  ],
);

export type ExternalAppToolSnapshot =
  typeof externalAppToolSnapshots.$inferSelect;
export type NewExternalAppToolSnapshot =
  typeof externalAppToolSnapshots.$inferInsert;

/**
 * Which connection ONE viewer wants ONE page to read through.
 *
 * A page names a provider and the server picks — the viewer's own connection
 * first, the team's second (`resolvePageConnection`). That covers the common
 * case and nothing else: with two accounts on the same app, the pick was a coin
 * toss the viewer could not overrule, and the "pin one with connectionId"
 * advice it used to print is addressed to the page's author, not to the person
 * reading it.
 *
 * PER USER by construction — `user_id` is NOT NULL. Choosing a connection is a
 * statement about whose data you want to see, so it must never leak onto a
 * colleague's screen. The page author's `connectionId` pin still wins over it:
 * a pin means "everybody uses this exact account", which is a different, and
 * deliberate, decision.
 *
 * `page_id` NULL is the viewer's DEFAULT for that provider, used by any page
 * with no row of its own. Nothing writes it yet; the shape is here so adding
 * that endpoint later needs no migration.
 */
export const externalAppConnectionPreferences = pgTable(
  "external_app_connection_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerKey: varchar("provider_key", { length: 64 }).notNull(),
    /** NULL = this viewer's default for the provider, on every page. */
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }),
    /** Cascades: a removed connection can never leave a preference pointing at
     *  an account that is gone. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => externalAppConnections.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Two partial indexes rather than one over a nullable column: Postgres
    // NULLS DISTINCT (the default) would let a viewer accumulate any number of
    // "default" rows, since every NULL `page_id` differs from every other. Same
    // shape as `uniq_eats_curated` / `uniq_eats_custom` above.
    uniqueIndex("uniq_eacp_page")
      .on(t.userId, t.teamId, t.providerKey, t.pageId)
      .where(sql`${t.pageId} IS NOT NULL`),
    uniqueIndex("uniq_eacp_default")
      .on(t.userId, t.teamId, t.providerKey)
      .where(sql`${t.pageId} IS NULL`),
    index("idx_eacp_lookup").on(t.userId, t.teamId, t.providerKey),
  ],
);

export type ExternalAppConnectionPreference =
  typeof externalAppConnectionPreferences.$inferSelect;
export type NewExternalAppConnectionPreference =
  typeof externalAppConnectionPreferences.$inferInsert;
