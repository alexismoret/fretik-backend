import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";

/**
 * What a team already knows, written down once and injected into every turn
 * without retrieving anything.
 *
 * Every other memory surface answers a QUESTION: `ai_memories` and
 * `ai_episodes` are searched, ranked and filtered per turn, which means a fact
 * the team has known for months is re-found from scratch each time and is only
 * present when the retriever happens to rank it. This table is the opposite —
 * a small, always-present summary maintained in the background, so broad or
 * badly-posed questions ("fais le point sur X", "où on en est ?") have
 * something to stand on before any search runs.
 *
 * **Why a dedicated table and not a reserved path in `ai_memories`.** Three
 * things would go wrong with a path, and each of them silently: the `memory`
 * tool could read and overwrite it, `<memory_index>` would list it to the model
 * as an ordinary file, and the vectoriser would embed it into the very arm the
 * digest is supposed to keep out of the block (a digest retrieved as a search
 * hit is the same content twice, competing with its own sources). Reserving a
 * hidden path is not available either — `parseMemoryPath` rejects hidden
 * segments by design.
 *
 * **Team scope only, never a row per user.** The digest is injected into every
 * turn of every member, so a user-scoped fact inside it would be read by
 * teammates who are not allowed to see it. `collect-inputs` must therefore
 * refuse to read any row carrying a `user_id`, and that rule belongs there as
 * much as here.
 */
export const teamMemoryDigests = pgTable("team_memory_digests", {
  /**
   * The primary key IS the team. One row per team, so serving the digest is a
   * single primary-key lookup — which is what makes it affordable on a path
   * that runs before every answer. Anything that would make this a range scan
   * (a version history in the same table, a row per model, a row per language)
   * belongs in another table.
   */
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),

  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),

  /**
   * The rendered digest, markdown, injected verbatim. Bounded by the generator
   * (`DIGEST_MAX_TOKENS`) rather than here: a byte cap in the column would cut
   * a provenance marker in half and hand the agent an id it would then call its
   * tools with for nothing — the same trap the verbatim block's size cap
   * already documents.
   */
  content: text("content").notNull(),

  /**
   * The digest this one replaced. Exists so a bad rewrite is recoverable
   * without a backup: the generator overwrites in place, and a digest is served
   * on EVERY turn, so "restore the previous one" has to be a query rather than
   * an incident.
   */
  previousContent: text("previous_content"),

  /** Measured with the same tokeniser as the prompt budget, not estimated. */
  tokenCount: integer("token_count").notNull(),

  /** Increments on every write. Cheap way to tell two digests apart in a log. */
  version: integer("version").default(1).notNull(),

  /**
   * Hash of the INPUTS this digest was built from (sorted ids + their
   * `updated_at`). The generator compares before spending a model call, so a
   * nightly job over a team that changed nothing costs one hash and no tokens.
   *
   * It also has to be the inputs and not the output: hashing the content would
   * make an unchanged corpus look changed whenever the model phrased it
   * differently, which is exactly backwards.
   */
  sourceFingerprint: text("source_fingerprint").notNull(),

  /**
   * Which rows the digest was built from. Read back at injection time to
   * suppress the same memories and episodes from `<active_memory>` — the same
   * fact rendered twice, once summarised and once verbatim, spends budget to
   * make the model less sure which one is current.
   *
   * Records are deliberately NOT excluded: a record card carries fields the
   * digest never had room for.
   */
  sources: jsonb("sources")
    .$type<TeamMemoryDigestSources>()
    .default({ memoryPaths: [], episodeIds: [], recordIds: [] })
    .notNull(),

  /** Which model wrote it, so a quality change can be traced to a model change. */
  modelProfileKey: varchar("model_profile_key", { length: 128 }),

  generatedAt: timestamp("generated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),

  /**
   * Set when the last regeneration did NOT produce a usable digest — an empty
   * completion, a `finishReason` of `length`, or a marker that failed to
   * resolve. The previous content keeps being served (a slightly old digest is
   * worth far more than none), and this column is what says so out loud instead
   * of letting it look fresh forever.
   */
  staleAt: timestamp("stale_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull()
    .$onUpdateFn(() => new Date()),
});

/**
 * The ids behind a digest.
 *
 * Paths for memories and uuids for episodes/records, because that is what each
 * one is addressed by everywhere else — `ai_memories` is a path namespace and
 * the block renders `(memory:<path>)`, while episodes and records are rendered
 * by uuid.
 */
export interface TeamMemoryDigestSources {
  memoryPaths: string[];
  episodeIds: string[];
  recordIds: string[];
}

export type TeamMemoryDigest = typeof teamMemoryDigests.$inferSelect;
export type NewTeamMemoryDigest = typeof teamMemoryDigests.$inferInsert;
