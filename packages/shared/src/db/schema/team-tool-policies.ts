import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import { team } from "./auth-schema";

/**
 * Per-team tool permission policy. A team customises which policy-managed
 * builtin tools the assistant may run and whether a run pauses for approval
 * first; the code catalog (`schemas/tool-policies` `BUILTIN_TOOL_POLICY_CATALOG`)
 * holds the defaults. One row per team, created lazily on first write — its
 * absence means "use the code defaults".
 *
 * `policies` is a SPARSE map keyed by tool registry name → level
 * (`auto | approval | blocked`). An absent key falls back to the catalog
 * default (read → `auto`, write → `approval`). Keys are validated against the
 * catalog at write time and re-resolved at runtime, where an unknown key is
 * simply ignored — never an error.
 *
 * External-app action policies live elsewhere (per connection, on
 * `external_app_connections.action_policies`) because a connection can be
 * personal (owned by one user) rather than team-scoped. Mirrors the 1:1
 * PK=FK pattern of `team_ai_settings`.
 */
export const teamToolPolicies = pgTable("team_tool_policies", {
  // PK is also FK to team.
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),

  /** Sparse `{ [toolName]: level }` — absent key = catalog default. */
  policies: jsonb("policies")
    .$type<Record<string, ToolPolicyLevel>>()
    .notNull()
    .default({}),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type TeamToolPolicies = typeof teamToolPolicies.$inferSelect;
export type NewTeamToolPolicies = typeof teamToolPolicies.$inferInsert;
