import { jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { FunctionProfileKeys } from "../../model-registry/functions";
import type { ReasoningLevelInput } from "../../schemas/reasoning";
import { team } from "./auth-schema";

/**
 * Per-team model selection. A team customises which model profile serves each
 * FUNCTION; the code registry (`@fretik/ai` `lib/model-registry`) holds the
 * defaults. One row per team, created lazily on first write — its absence
 * means "use the code defaults".
 *
 * Keys are validated at write time (`@fretik/ai` `selectableForFunction`) and
 * again at resolution time, where an unknown or no-longer-usable key degrades
 * gracefully to the default — never an error. A model can be retired between
 * the moment a team picked it and the moment a turn resolves it, and that is
 * not a reason to fail the turn.
 *
 * Lives next to (not inside) `team_settings` so AI model config evolves
 * independently of auth/billing team config. Mirrors the 1:1 PK=FK pattern.
 */
export const teamAiSettings = pgTable("team_ai_settings", {
  // PK is also FK to team.
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),

  /**
   * The team's model per FUNCTION. Replaces the three tier columns
   * (`flagship_profile_key` / `workhorse_profile_key` / `utility_profile_key`),
   * whose contents the same migration folds in here.
   *
   * One jsonb rather than a column per function, and rather than a row per
   * function. Granularity changes without a migration (seven functions today,
   * and a `hostConstraints` sibling is already foreseen), and the whole object
   * arrives in the single 1:1 read the hot path already makes under a 3 s soft
   * timeout — a second table would put a join, or a second cache key, on the
   * path of every turn.
   *
   * A missing key means "use the code default". Validated at the WRITE
   * (`selectableForFunction`); a key that later stops being usable degrades at
   * the read rather than erroring, because a model going away must not break a
   * team's turns.
   */
  functionProfileKeys: jsonb("function_profile_keys")
    .$type<FunctionProfileKeys>()
    .default({})
    .notNull(),

  /**
   * How hard the team's ASSISTANT model thinks by default (a `ReasoningLevel` —
   * see @fretik/shared `schemas/reasoning.ts`). Null = the profile's own
   * `assessment.reasoning.defaultLevel`.
   *
   * Assistant only, deliberately: every other function hardcodes its effort per
   * `settingsKind` (pre-extract → minimal, recall → medium, …) because those
   * envelopes are calibrated system components, not preferences.
   *
   * RESET TO NULL whenever the assistant model changes — a level is meaningful
   * only against the model it was chosen for ("high" on Luna and "high" on
   * GLM-5.2 cost and behave nothing alike), and the effort ladders differ per
   * model, so carrying it over could pin a level the new model rejects. See
   * `services/team-ai-settings/upsert.ts`.
   *
   * The COLUMN is still called `flagship_reasoning_level`: renaming it carries
   * every team's stored depth across a rename drizzle-kit only generates
   * interactively, which is not worth doing for a storage name nothing outside
   * this file reads. Every name in the code and on the wire says `assistant`.
   */
  assistantReasoningLevel: varchar("flagship_reasoning_level", {
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
