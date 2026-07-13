import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SKILL_VERSION_MAX_LENGTH,
} from "../../schemas/skills-limits";
import { team, user } from "./auth-schema";

/**
 * Source of a skill — drives where the SKILL.md body actually lives.
 *
 *  - `bundled`      : ships under `backend/packages/ai/src/skills/bundled/`,
 *                     `team_id` is NULL (global catalogue). The filesystem
 *                     is source-of-truth; the `body` column stays NULL
 *                     (loader reads from disk and tarballs it into the
 *                     sandbox). The DB row exists only to anchor team
 *                     overrides.
 *  - `team_uploaded`: scoped to a `team_id`. The full SKILL.md body lives
 *                     in the `body` column (NOT NULL, enforced by check
 *                     constraint). The bootstrap pipeline writes each
 *                     enabled team skill to `/workspace/skills/<slug>/`
 *                     after the bundled tarball is unpacked.
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

    name: varchar("name", { length: SKILL_NAME_MAX_LENGTH }).notNull(),

    description: text("description").notNull(),

    /**
     * Full SKILL.md body in markdown. NULL for `source = 'bundled'`
     * (filesystem is source-of-truth, loader tarballs the on-disk file).
     * NOT NULL for `source = 'team_uploaded'` (enforced by check
     * constraint below). Hard cap at 100 KB (~25k tokens) — also a
     * check constraint, applies regardless of source so future bundled
     * mirroring stays safe.
     */
    body: text("body"),

    isDefault: boolean("is_default").notNull().default(false),

    /**
     * Meta skills are bundled infrastructure consumed by chatbot
     * tools (or other platform code), NOT by the user directly.
     * They're pushed to the conversation sandbox like any other
     * bundled skill, but hidden from both human-visible surfaces:
     *  - the system-prompt `{{skillsCatalog}}` (saves ~100-300
     *    tokens per turn, avoids tempting the chatbot into reading
     *    them when irrelevant),
     *  - the settings/skills page (these aren't workflows the team
     *    toggles — showing them just adds noise for non-tech users).
     *
     * The auto-sync at boot picks the initial value from the
     * SKILL.md frontmatter (`metadata.fretik_is_meta`); existing
     * rows are never overwritten.
     */
    isMeta: boolean("is_meta").notNull().default(false),

    source: skillSourceEnum("source").notNull().default("bundled"),

    /**
     * Provenance for a catalog-installed skill (`team_uploaded` from the skills
     * hub / the agent's install tool), e.g. `skills.sh:<owner>/<repo>/<slug>`.
     * NULL for hand-authored and bundled skills. Used to dedupe re-installs and,
     * later, to check the source for updates.
     */
    sourceUrl: varchar("source_url", { length: 2048 }),

    /**
     * Content hash of the skill bundle at install time (skills.sh `hash`).
     * NULL for hand-authored/bundled skills. Provenance + lets a later upstream
     * edit be detected without re-reading the whole body.
     */
    sourceHash: varchar("source_hash", { length: 128 }),

    /**
     * Number of companion files in the source bundle that were NOT installed
     * (we store the SKILL.md body only). >0 surfaces a "this skill ships N extra
     * files" warning in the UI. 0 for single-file and hand-authored skills.
     */
    sourceSkippedFiles: integer("source_skipped_files").notNull().default(0),

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
    version: varchar("version", { length: SKILL_VERSION_MAX_LENGTH })
      .notNull()
      .default("1.0.0"),

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
    // Hard cap on body size: 100 KB ≈ 25k tokens. Applies to bundled
    // too in case we ever mirror them into the column.
    check(
      "skills_body_max_length",
      sql`${t.body} IS NULL OR length(${t.body}) <= ${sql.raw(SKILL_BODY_MAX_BYTES.toString())}`,
    ),
    // team_uploaded MUST carry the body in-DB (no filesystem fallback).
    // bundled MAY have NULL (loader reads from disk).
    check(
      "skills_body_required_for_team_uploaded",
      sql`${t.source} = 'bundled' OR ${t.body} IS NOT NULL`,
    ),
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
