import { sql } from "drizzle-orm";
import db from "../../db";
import { DOCUMENT_COLLECTION_KEY } from "../collections/constants";

/**
 * Everything the team digest is allowed to be built from, gathered
 * deterministically.
 *
 * No model runs here, and that is the point: the generator downstream turns
 * these rows into prose, but WHICH rows exist is decided by SQL with fixed
 * windows and fixed caps. A digest is served on every turn of every member, so
 * "what went into it" has to be answerable months later from the code rather
 * than from a sampling of the model's mood.
 *
 * **Team scope only.** Every query below filters `user_id IS NULL`. The digest
 * reaches teammates who may not be allowed to read a given user's private
 * memories or episodes, so a single user-scoped row leaking in here is a
 * privacy incident that no downstream check would catch — the generator cannot
 * tell a private fact from a shared one once it is prose.
 */

/** Team-scope memories. 30 is a cap on the PROMPT, not a belief about corpora. */
const MAX_CONVENTIONS = 30;
/**
 * A convention is a rule ("weekly recap goes in a table ordered by urgency"),
 * and a rule that needs more than this is not a rule the digest can carry —
 * it stays in `ai_memories`, where the agent can still open it in full.
 */
const CONVENTION_CLIP = 600;

/** Records the team actually works with, not records it happens to have. */
const MAX_ENTITIES = 15;
/** Enough to say what an entity is connected to, not enough to draw the graph. */
const LINKS_PER_ENTITY = 3;
/** A link older than a quarter says the entity existed, not that it is live. */
const ENTITY_LINK_WINDOW_DAYS = 90;
/** Events move faster than links, so they get a tighter window. */
const ENTITY_EVENT_WINDOW_DAYS = 30;

/** "Current decisions" — two months is roughly a decision's useful memory. */
const DECISION_WINDOW_DAYS = 60;
const MAX_DECISIONS = 12;
/** A decision's WHAT and WHEN fit here; its full reasoning does not, by design. */
const DECISION_CLIP = 400;

/** Open threads are a fortnight's worth or they are not open. */
const THREAD_WINDOW_DAYS = 14;
const MAX_THREADS = 8;
const THREAD_CLIP = 300;

export interface DigestScope {
  organizationId: string;
  teamId: string;
}

export interface DigestConvention {
  path: string;
  content: string;
  updatedAt: Date;
}

export interface DigestEntity {
  id: string;
  label: string;
  collectionKey: string;
  /**
   * At most `LINKS_PER_ENTITY`, each `<predicate> → <other>` when this record
   * is the SUBJECT and `<predicate> ← <other>` when it is the object.
   *
   * The arrow is load-bearing, not decoration. Rendering both directions the
   * same way put "Horizon supplies Nordwind" in a real digest off Nordwind's
   * own `supplies` edge — a false statement, served on every turn, with a
   * provenance marker that resolves and so survives every gate downstream.
   */
  links: string[];
  updatedAt: Date;
}

export interface DigestDecision {
  id: string;
  title: string;
  summary: string;
  occurredTo: Date | null;
  updatedAt: Date;
}

export interface DigestThread {
  id: string;
  title: string;
  summary: string;
  updatedAt: Date;
}

export interface DigestInputs {
  conventions: DigestConvention[];
  entities: DigestEntity[];
  decisions: DigestDecision[];
  threads: DigestThread[];
  /**
   * sha256 over the ids and `updated_at` of everything above, sorted.
   *
   * Hashing the INPUTS and not the rendered digest is load-bearing: the model
   * phrases the same corpus differently on every call, so a content hash would
   * report change on a team that changed nothing and rewrite the digest nightly
   * for no reason. This way an unchanged team costs one hash and zero tokens.
   */
  fingerprint: string;
}

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * A raw `db.execute` does NOT apply the column parsers the query builder does,
 * so a `timestamptz` arrives as a string however the row interface is
 * annotated. Declaring `Date` there compiles perfectly and then throws on the
 * first `.toISOString()` — the failure mode this codebase already has a scar
 * from. So the row types say what the driver actually sends, and every
 * timestamp goes through here.
 */
type RawTimestamp = string | Date;

const toDate = (value: RawTimestamp): Date =>
  value instanceof Date ? value : new Date(value);

interface ConventionRow extends Record<string, unknown> {
  path: string;
  content: string;
  updated_at: RawTimestamp;
}

/**
 * Team conventions, `learned/` first.
 *
 * The ordering is the whole value of this arm: `learned/` is where the
 * distillation writes what it inferred from how the team actually works, and
 * those are the rules a broad question needs. Hand-written memories still get
 * in, they just do not push the learned ones out of a 30-row budget.
 */
const collectConventions = async (
  scope: DigestScope,
): Promise<DigestConvention[]> => {
  const rows = await db.execute<ConventionRow>(sql`
    SELECT path, content, updated_at
    FROM ai_memories
    WHERE team_id = ${scope.teamId}
      AND organization_id = ${scope.organizationId}
      AND scope = 'team'
      AND user_id IS NULL
    ORDER BY (path LIKE 'learned/%') DESC, updated_at DESC
    LIMIT ${MAX_CONVENTIONS}
  `);
  return rows.rows.map((row) => ({
    path: row.path,
    content: clip(row.content, CONVENTION_CLIP),
    updatedAt: toDate(row.updated_at),
  }));
};

interface EntityRow extends Record<string, unknown> {
  id: string;
  label: string;
  collection_key: string;
  updated_at: RawTimestamp;
  links: string[] | null;
}

/**
 * The records the team is actually working with.
 *
 * Ranked by recent CONNECTION and recent ACTIVITY rather than by row age,
 * because a collection's biggest row is usually its oldest one. Links carry the
 * longer window (a relationship stays true longer than an event stays
 * interesting), and both are counted inside the window rather than in total —
 * a record with two hundred links from last year is not what the team is doing
 * this month.
 *
 * One statement, with the per-entity link lines pulled in the same pass: this
 * runs in a background job, but fifteen extra round trips to render three lines
 * each is the shape that turns a job into a timeout.
 *
 * **Document mirror records are excluded, and that is not a detail.** Every
 * extracted mention becomes an edge, which makes them the most densely linked
 * rows in the graph — measured on the EVAL team, they took most of the fifteen
 * slots and turned "key entities" into a list of PDF filenames. The digest
 * exists to name who and what the team works WITH; a document is already
 * reachable through the memory index, the documents tool, and the documents arm
 * of recall.
 */
const collectEntities = async (scope: DigestScope): Promise<DigestEntity[]> => {
  const linkSince = daysAgo(ENTITY_LINK_WINDOW_DAYS);
  const eventSince = daysAgo(ENTITY_EVENT_WINDOW_DAYS);

  const rows = await db.execute<EntityRow>(sql`
    WITH ranked AS (
      SELECT
        r.id,
        r.label,
        c.key AS collection_key,
        r.updated_at,
        (
          SELECT count(*) FROM links l
          WHERE (l.from_record_id = r.id OR l.to_record_id = r.id)
            AND l.status = 'confirmed'
            AND l.created_at >= ${linkSince}
        ) AS link_count,
        (
          SELECT count(*) FROM domain_events e
          WHERE e.subject_record_id = r.id
            AND e.occurred_at >= ${eventSince}
        ) AS event_count
      FROM collection_records r
      JOIN collections c ON c.id = r.collection_id
      WHERE r.team_id = ${scope.teamId}
        AND r.organization_id = ${scope.organizationId}
        AND r.status = 'confirmed'
        -- Document mirror records are excluded; see the note above the function.
        AND c.key <> ${DOCUMENT_COLLECTION_KEY}
    )
    SELECT
      ranked.id,
      ranked.label,
      ranked.collection_key,
      ranked.updated_at,
      (
        SELECT array_agg(line ORDER BY line)
        FROM (
          -- Grouped, not just limited: two edges of the same type to the same
          -- neighbour render identically, and one line repeated spends a third
          -- of the entity's budget saying one thing.
          SELECT
            CASE
              WHEN l.from_record_id = ranked.id
                THEN lt.label || ' → ' || other.label
              -- Reverse edge. An inverse_label already reads in that direction
              -- ("supplied by"), so it keeps the forward arrow; without one the
              -- arrow itself carries the direction.
              WHEN lt.inverse_label IS NOT NULL
                THEN lt.inverse_label || ' → ' || other.label
              ELSE lt.label || ' ← ' || other.label
            END AS line,
            max(l.created_at) AS last_seen
          FROM links l
          JOIN link_types lt ON lt.id = l.link_type_id
          JOIN collection_records other
            ON other.id = CASE
                 WHEN l.from_record_id = ranked.id THEN l.to_record_id
                 ELSE l.from_record_id
               END
          WHERE (l.from_record_id = ranked.id OR l.to_record_id = ranked.id)
            AND l.status = 'confirmed'
          GROUP BY 1
          ORDER BY last_seen DESC
          LIMIT ${LINKS_PER_ENTITY}
        ) top_links
      ) AS links
    FROM ranked
    WHERE ranked.link_count > 0 OR ranked.event_count > 0
    ORDER BY (ranked.link_count + ranked.event_count) DESC, ranked.updated_at DESC
    LIMIT ${MAX_ENTITIES}
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    label: row.label,
    collectionKey: row.collection_key,
    links: row.links ?? [],
    updatedAt: toDate(row.updated_at),
  }));
};

interface EpisodeRow extends Record<string, unknown> {
  id: string;
  title: string;
  summary: string;
  occurred_to: RawTimestamp | null;
  updated_at: RawTimestamp;
}

/**
 * What the team decided lately.
 *
 * `state = 'active'` excludes both halves of the contradiction problem for
 * free: a superseded episode points at its survivor and a demoted one left the
 * recall index. Consolidated episodes are included deliberately — a
 * consolidation IS the distilled version of several conversations, which is
 * exactly the shape a digest wants.
 *
 * **`user_id IS NULL` is not a conservative guess, it is the existing privacy
 * boundary.** `distillConversation` already decides scope at write time: a
 * conversation with one member produces a PRIVATE episode, one with two or more
 * produces a team-visible one (`userId = null`), and a workflow inherits the
 * workflow's own visibility. So this filter selects exactly the episodes the
 * team can already see, and reads nothing it would have to be trusted with.
 * Do not relax it to "surface more": on a team whose conversations are mostly
 * solo the correct answer really is a short list.
 */
const collectDecisions = async (
  scope: DigestScope,
): Promise<DigestDecision[]> => {
  const since = daysAgo(DECISION_WINDOW_DAYS);
  const rows = await db.execute<EpisodeRow>(sql`
    SELECT id, title, summary, occurred_to, updated_at
    FROM ai_episodes
    WHERE team_id = ${scope.teamId}
      AND organization_id = ${scope.organizationId}
      AND user_id IS NULL
      AND state = 'active'
      AND kind IN ('conversation', 'consolidated')
      AND coalesce(occurred_to, created_at) >= ${since}
    ORDER BY coalesce(occurred_to, created_at) DESC
    LIMIT ${MAX_DECISIONS}
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: clip(row.summary, DECISION_CLIP),
    occurredTo: row.occurred_to === null ? null : toDate(row.occurred_to),
    updatedAt: toDate(row.updated_at),
  }));
};

/** What is still moving — `record_activity` is the kind that tracks it. */
const collectThreads = async (scope: DigestScope): Promise<DigestThread[]> => {
  const since = daysAgo(THREAD_WINDOW_DAYS);
  const rows = await db.execute<EpisodeRow>(sql`
    SELECT id, title, summary, occurred_to, updated_at
    FROM ai_episodes
    WHERE team_id = ${scope.teamId}
      AND organization_id = ${scope.organizationId}
      AND user_id IS NULL
      AND state = 'active'
      AND kind = 'record_activity'
      AND coalesce(occurred_to, created_at) >= ${since}
    ORDER BY coalesce(occurred_to, created_at) DESC
    LIMIT ${MAX_THREADS}
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: clip(row.summary, THREAD_CLIP),
    updatedAt: toDate(row.updated_at),
  }));
};

/**
 * `Bun.CryptoHasher` and not `Bun.hash`: this value is persisted and compared
 * across processes and releases, and `Bun.hash` makes no stability guarantee
 * across versions — a runtime upgrade would silently invalidate every
 * fingerprint and rewrite every digest.
 */
const fingerprintOf = (parts: { id: string; updatedAt: Date }[]): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const part of [...parts].sort((a, b) => a.id.localeCompare(b.id))) {
    hasher.update(`${part.id}:${part.updatedAt.toISOString()}\n`);
  }
  return hasher.digest("hex");
};

export const collectDigestInputs = async (
  scope: DigestScope,
): Promise<DigestInputs> => {
  // Four independent reads; nothing here depends on anything else here.
  const [conventions, entities, decisions, threads] = await Promise.all([
    collectConventions(scope),
    collectEntities(scope),
    collectDecisions(scope),
    collectThreads(scope),
  ]);

  return {
    conventions,
    entities,
    decisions,
    threads,
    fingerprint: fingerprintOf([
      // Memories are addressed by path everywhere else, so the path is their id
      // here too — a rename has to count as a change.
      ...conventions.map((c) => ({
        id: `memory:${c.path}`,
        updatedAt: c.updatedAt,
      })),
      ...entities.map((e) => ({
        id: `record:${e.id}`,
        updatedAt: e.updatedAt,
      })),
      ...decisions.map((d) => ({
        id: `episode:${d.id}`,
        updatedAt: d.updatedAt,
      })),
      ...threads.map((t) => ({
        id: `episode:${t.id}`,
        updatedAt: t.updatedAt,
      })),
    ]),
  };
};
