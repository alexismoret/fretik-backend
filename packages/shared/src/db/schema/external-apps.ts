import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";

/**
 * External apps — connections to third-party SaaS (Outlook, Gmail, …) via
 * Nango, and the human-in-the-loop approval gate for write actions the
 * chatbot performs on them.
 *
 * The provider catalogue itself (which apps exist, which actions, their
 * endpoints) is NOT in the database — it lives as YAML manifests under
 * `src/external-apps/providers/<key>/manifest.yaml`, loaded into a registry
 * at boot. The DB only stores per-tenant connections and approval state.
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

/**
 * Status of a write-action approval request.
 *
 *  - `pending`   : awaiting the user's decision. Never expires — a request
 *                  stays actionable indefinitely (the user can approve it
 *                  days later; the card re-renders on conversation reload).
 *  - `granted`   : the user approved; not yet executed.
 *  - `executing` : claimed atomically from `granted` — execution in progress.
 *                  A re-run that lands here gets an explicit error (never a
 *                  silent NULL result), closing the crash window between
 *                  "consume the grant" and "store the result".
 *  - `consumed`  : executed; `result` holds the per-op outcomes. A re-run of
 *                  the identical plan returns this cached `result` — no
 *                  double-send.
 *  - `rejected`  : the user refused; `decisionFeedback` carries their note.
 */
export const toolApprovalStatusEnum = pgEnum("tool_approval_status", [
  "pending",
  "granted",
  "executing",
  "consumed",
  "rejected",
]);

/**
 * One row = ONE write-action plan submitted via `run_plan([...])` from the
 * chatbot sandbox. A plan bundles N independent write operations (possibly
 * across actions and providers) behind a single user approval.
 *
 * `lookup_hash` is the gate key: sha256 over every operation's *stable* args
 * (volatile fields such as message bodies are excluded — see the manifest's
 * `excludeFromHash`). It is frozen at creation. On re-run the agent re-emits
 * the same code → same operations → same hash → the grant is matched and the
 * stored (approved, possibly modified) `operations` are executed.
 *
 * Requests never expire: there is no `expires_at`. The durable state lives
 * here; the E2B sandbox may be recycled between turns without consequence.
 */
export const toolApprovalRequests = pgTable(
  "tool_approval_requests",
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
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    /** Sandbox turn that produced this plan — UI correlation only. */
    turnId: varchar("turn_id", { length: 128 }).notNull(),

    /** Gate key — sha256 of the plan's stable args, frozen at creation. */
    lookupHash: varchar("lookup_hash", { length: 64 }).notNull(),

    /**
     * The plan: `[{ action, args }, …]`. `args` are the executable args,
     * mutable via `modify-and-grant`. Execution always uses these stored
     * args, never the args of a re-run call.
     */
    operations: jsonb("operations").$type<ToolApprovalOperation[]>().notNull(),
    itemCount: integer("item_count").notNull(),

    /** Display payload for the approval card — built by the summary fns. */
    summary: jsonb("summary").$type<ToolApprovalSummary>().notNull(),

    /**
     * Per-operation outcomes, written incrementally as ops complete so a
     * crash mid-execution still leaves a partial trace. NULL until the
     * first op finishes.
     */
    result: jsonb("result").$type<ToolApprovalOpResult[]>(),

    status: toolApprovalStatusEnum("status").notNull().default("pending"),

    decisionAt: timestamp("decision_at", {
      mode: "date",
      withTimezone: true,
    }),
    decidedByUserId: uuid("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decisionFeedback: text("decision_feedback"),

    executedAt: timestamp("executed_at", {
      mode: "date",
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_tar_lookup").on(t.conversationId, t.lookupHash, t.status),
    index("idx_tar_conversation").on(t.conversationId),
  ],
);

/** One write operation inside a plan. */
export interface ToolApprovalOperation {
  /** Fully-qualified action name, e.g. `outlook.send_email`. */
  action: string;
  /** Executable args (validated against the manifest at dispatch). */
  args: Record<string, unknown>;
}

/**
 * A field shown on the approval card. The label is referenced by i18n key
 * (`chatbot.approvals.fields.<labelKey>`) so the frontend can translate it;
 * the value is data (recipients, subject, etc.) and is shown as-is.
 */
export interface ToolApprovalSummaryField {
  /** i18n key suffix under `chatbot.approvals.fields.*`. */
  labelKey: string;
  value: string;
  /** `text` (default) or `html` (rendered) for rich values like email bodies. */
  kind?: "text" | "html";
}

/**
 * Approval card payload — fully translatable. Every human string is an
 * i18n key + interpolation params; the backend never composes display
 * strings.
 */
export interface ToolApprovalSummary {
  /** i18n key for the plan-level title (e.g. `chatbot.approvals.plan.title`). */
  titleKey: string;
  /** Interpolation values for the plan title (e.g. `{ count: 3 }`). */
  titleParams?: Record<string, string | number>;
  operations: ToolApprovalOperationSummary[];
}

export interface ToolApprovalOperationSummary {
  providerKey: string;
  action: string;
  /** i18n key under `chatbot.approvals.<providerKey>.<action>.title`. */
  titleKey: string;
  titleParams?: Record<string, string | number>;
  fields: ToolApprovalSummaryField[];
}

/** Outcome of a single operation after execution. */
export type ToolApprovalOpResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export type ExternalAppConnection = typeof externalAppConnections.$inferSelect;
export type NewExternalAppConnection =
  typeof externalAppConnections.$inferInsert;
export type ExternalAppConnectionStatus = ExternalAppConnection["status"];

export type ToolApprovalRequest = typeof toolApprovalRequests.$inferSelect;
export type NewToolApprovalRequest = typeof toolApprovalRequests.$inferInsert;
export type ToolApprovalStatus = ToolApprovalRequest["status"];
