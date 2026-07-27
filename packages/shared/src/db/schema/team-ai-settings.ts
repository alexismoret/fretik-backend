import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { ReasoningLevelInput } from "../../schemas/reasoning";
import { team } from "./auth-schema";

/**
 * Per-team model selection (chantier C8). A team customises which model
 * profile serves each registry tier; the code registry (`@fretik/ai`
 * `lib/model-registry`) holds the defaults. One row per team, created
 * lazily on first write — its absence means "use the code defaults".
 *
 * Each column stores a registry profile **key** (e.g. `minimax-m3`), or
 * `null` to fall back to the code-default binding for that tier. Keys are
 * validated against the registry at write time (`@fretik/ai`
 * `isSelectableForTier`) and again at resolution time, where an unknown or
 * gate-failed key degrades gracefully to the default — never an error.
 *
 * Lives next to (not inside) `team_settings` so AI model config evolves
 * independently of auth/billing team config. Mirrors the 1:1 PK=FK pattern.
 */
export const teamAiSettings = pgTable("team_ai_settings", {
  // PK is also FK to team.
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),

  // Registry profile keys are short, stable slugs — `varchar(64)` is ample.
  // Main chatbot loop. Null = code default (`ROLE_BINDINGS.chat`).
  flagshipProfileKey: varchar("flagship_profile_key", { length: 64 }),
  // Auxiliary work (pre-extract, sub-agents, compaction). Null = code default.
  workhorseProfileKey: varchar("workhorse_profile_key", { length: 64 }),
  // Micro-tasks (memory recall, titles, reformulation). Null = code default.
  utilityProfileKey: varchar("utility_profile_key", { length: 64 }),

  /**
   * How hard the team's FLAGSHIP model thinks by default (a `ReasoningLevel` —
   * see @fretik/shared `schemas/ai.ts` `reasoningLevelSchema`). Null = the
   * profile's own `assessment.reasoning.defaultLevel`.
   *
   * Flagship only, deliberately: workhorse/utility roles hardcode their effort
   * per `settingsKind` (pre-extract → minimal, recall → medium, …) because
   * those envelopes are calibrated system components, not preferences.
   *
   * RESET TO NULL whenever `flagshipProfileKey` changes — a level is meaningful
   * only against the model it was chosen for ("high" on Luna and "high" on
   * GLM-5.2 cost and behave nothing alike), and the effort ladders differ per
   * model, so carrying it over could pin a level the new model rejects. See
   * `services/team-ai-settings/upsert.ts`.
   */
  flagshipReasoningLevel: varchar("flagship_reasoning_level", {
    length: 16,
  }).$type<ReasoningLevelInput>(),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type TeamAiSettings = typeof teamAiSettings.$inferSelect;
export type NewTeamAiSettings = typeof teamAiSettings.$inferInsert;
