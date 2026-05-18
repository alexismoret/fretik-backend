import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { team, user } from "./auth-schema";

/**
 * Source of a skill — drives where the SKILL.md body actually lives.
 *
 *  - `bundled`      : ships under `backend/packages/ai/src/skills/bundled/`,
 *                     `team_id` is NULL (global catalogue). The filesystem
 *                     is source-of-truth; the DB row mirrors the catalogue
 *                     so we can attach team overrides without coupling to
 *                     the AI service.
 *  - `team_uploaded`: placeholder for the future user-upload story. A
 *                     `team_id` will be set; the SKILL.md body will live
 *                     in object storage and be hydrated into the sandbox
 *                     alongside bundled skills. No UI exposes this yet.
 */
export const skillSourceEnum = pgEnum("skill_source", [
  "bundled",
  "team_uploaded",
]);

/**
 * Skill catalogue. One row per (source, team_id, name).
 *
 * `is_default = true` marks a skill as always-on for every team: the API
 * refuses any toggle attempt, and the `team_skills` table is never read
 * for it. Always-on skills are how Fretik guarantees its core file
 * generation (docx/pdf/pptx/xlsx/doc-coauthoring) is available everywhere.
 *
 * Catalogue sync at AI service boot: the loader walks the filesystem,
 * upserts each bundled SKILL.md, and soft-deletes any DB row that no
 * longer has a matching folder. `deleted_at IS NOT NULL` filters the
 * skill out of every listing (UI + agent prompt) without breaking team
 * overrides that may already exist for nostalgia.
 *
 * Constraints worth knowing:
 *   - `name` length 64 + lowercase slug chars matches the official
 *     agentskills.io spec (we validate `[a-z0-9-]` at the loader).
 *   - `(team_id, name)` uniqueness lets two different teams upload
 *     skills with the same name in the future without colliding with
 *     each other or with a bundled skill.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    name: varchar("name", { length: 64 }).notNull(),

    description: text("description").notNull(),

    isDefault: boolean("is_default").notNull().default(false),

    source: skillSourceEnum("source").notNull().default("bundled"),

    /**
     * NULL for `source = 'bundled'` (global catalogue). Set for
     * `team_uploaded` so a future per-team skill is scoped + cascades
     * on team deletion.
     */
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    /**
     * Free-form version string mirrored from the SKILL.md frontmatter
     * (`metadata.fretik_version`). Used for cache busting on the
     * frontend listing and audit; the agent does not see it.
     */
    version: varchar("version", { length: 20 }).notNull().default("1.0.0"),

    /**
     * Soft-delete marker. The loader sets this when a bundled folder
     * disappears between two boots; the catalogue listing filters it
     * out. Team overrides keep their FK so reviving the skill (same
     * name) restores the previous toggle state for nostalgia.
     */
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index("skills_source_idx").on(t.source),
    // Composite uniqueness so two teams can register the same skill
    // name in the future (`team_uploaded`) without colliding with each
    // other or with the bundled catalogue (team_id IS NULL).
    unique("skills_team_name_unique").on(t.teamId, t.name),
  ],
);

/**
 * Team-level override of a skill's enabled state. Rows exist only when
 * a team explicitly toggled the skill — absence means "default state"
 * (which for now is always enabled, but kept abstract so a future
 * "default off" skill works without schema changes).
 *
 * The API rejects any UPSERT targeting a skill where `skills.is_default`
 * is true (see `services/skills/upsert-team-override.ts`).
 */
export const teamSkills = pgTable(
  "team_skills",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    enabled: boolean("enabled").notNull(),

    enabledAt: timestamp("enabled_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * Actor (owner/admin) who flipped the toggle. `set null` on user
     * deletion — the audit row stays even if the actor leaves.
     */
    updatedById: uuid("updated_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({ name: "team_skills_pk", columns: [t.teamId, t.skillId] }),
    index("team_skills_team_idx").on(t.teamId),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillSource = Skill["source"];

export type TeamSkill = typeof teamSkills.$inferSelect;
export type NewTeamSkill = typeof teamSkills.$inferInsert;
