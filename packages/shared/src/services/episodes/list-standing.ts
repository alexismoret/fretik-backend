import { sql } from "drizzle-orm";
import db from "../../db";
import type { AiEpisodeKind } from "../../db/schema";

/**
 * The episodes a turn is shown WITHOUT having matched them.
 *
 * Every other memory surface is query-shaped: `<active_memory>` needs the
 * message to match something lexically, semantically or through a record
 * anchor, and `searchKnowledge` needs the agent to ask. That is the right
 * default and it has one blind spot — a question that names nothing. "Où on en
 * est ?" hands retrieval a pronoun, and no amount of retrieval quality answers
 * it. This is the block that does.
 *
 * **Rendered at READ time, per reader.** The predicate is
 * `user_id IS NULL OR user_id = :caller` — the same one `listEpisodes`, the
 * graph arm and `searchKnowledge` use. That is not a detail, it is the reason
 * this shape exists: `distillConversation` writes a PRIVATE episode when a
 * conversation has one participant, so on a solo team — every team's first
 * weeks — everything the pipeline produces is user-scoped. A team-scoped
 * artefact built by a background job cannot carry those rows without being
 * generated once per user; computing the block at read time carries them with
 * no generation at all.
 *
 * Deterministic on purpose. The summaries here were already written by the
 * distiller, which has its own eval; a second model pass over them would be a
 * summary of summaries, and the five defects the generated digest produced in
 * one week (an inverted link direction stated as fact, a third of the sections
 * silently dropped, sixteen lines lost to a wrong marker prefix) are all
 * defects only a generation step can have.
 */

/**
 * Four weeks. "Lately" for a B2B team is roughly a month — shorter loses the
 * fortnightly rhythms most processes run on, longer stops being news.
 */
const WINDOW_DAYS = 30;
/** Record-activity digests are rolling, rebuilt weekly; older is superseded. */
const ACTIVITY_WINDOW_DAYS = 7;

/**
 * Caps are on the PROMPT, not on the corpus. This text is paid on every turn
 * of every member, so the block says what the team has been doing — it does
 * not try to be the archive. `visibleInWindow` reports what was left out so
 * the renderer can point at `searchKnowledge` instead of pretending.
 */
const MAX_DECISIONS = 10;
const MAX_ACTIVITY = 3;

export interface StandingEpisode {
  id: string;
  kind: AiEpisodeKind;
  title: string;
  summary: string;
  /** `coalesce(occurred_to, created_at)` — when it happened, not when it was written. */
  at: Date;
}

export interface StandingEpisodesResult {
  /** Already ordered, newest first. */
  items: StandingEpisode[];
  /** Everything in the window, including what the caps left out. */
  visibleInWindow: number;
}

export interface StandingEpisodesInput {
  organizationId: string;
  teamId: string;
  /** The reader. Required — the block is scoped to who is asking. */
  userId: string;
}

/** `db.execute` hands back timestamptz as a string, never a Date. */
type RawTimestamp = string | Date;

interface StandingRow extends Record<string, unknown> {
  id: string;
  kind: AiEpisodeKind;
  title: string;
  summary: string;
  at: RawTimestamp;
  visible_in_window: string | number;
}

const toDate = (value: RawTimestamp): Date =>
  value instanceof Date ? value : new Date(value);

export const listStandingEpisodes = async (
  input: StandingEpisodesInput,
): Promise<StandingEpisodesResult> => {
  const rows = await db.execute<StandingRow>(sql`
    WITH visible AS (
      SELECT id, kind, title, summary,
             coalesce(occurred_to, created_at) AS at
      FROM ai_episodes
      WHERE team_id = ${input.teamId}
        AND organization_id = ${input.organizationId}
        AND state = 'active'
        -- The privacy boundary. Deleting this clause is the one mutation that
        -- turns this function into a leak, so it is the one the integration
        -- test deletes.
        AND (user_id IS NULL OR user_id = ${input.userId})
        AND coalesce(occurred_to, created_at) >= now() - make_interval(days => ${WINDOW_DAYS})
    ),
    decisions AS (
      SELECT * FROM visible
      WHERE kind IN ('conversation', 'consolidated')
      ORDER BY at DESC
      LIMIT ${MAX_DECISIONS}
    ),
    activity AS (
      SELECT * FROM visible
      WHERE kind = 'record_activity'
        AND at >= now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
      ORDER BY at DESC
      LIMIT ${MAX_ACTIVITY}
    )
    SELECT u.*, (SELECT count(*) FROM visible) AS visible_in_window
    FROM (SELECT * FROM decisions UNION ALL SELECT * FROM activity) u
    ORDER BY at DESC
  `);

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      at: toDate(row.at),
    })),
    visibleInWindow: Number(rows.rows[0]?.visible_in_window ?? 0),
  };
};
