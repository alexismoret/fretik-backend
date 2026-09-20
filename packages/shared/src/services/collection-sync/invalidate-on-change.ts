import { sql } from "drizzle-orm";
import db from "../../db";
import {
  syncArgFieldKeys,
  syncReadStrategy,
  type SyncReadStrategy,
} from "../../schemas/collection-sync";
import { connectorAgentKey } from "./agent-key";

/**
 * "Somebody just filled in the SIRET — go and fetch the rest."
 *
 * This is what makes a `lookup` column feel live without a webhook and without
 * polling anything: the journal sweep already reads every `record.created` /
 * `record.updated` fifteen seconds after it commits, and a diff that touches a
 * key some lookup source binds is exactly the signal that the record's external
 * columns are now answerable. Marking it `pending` puts it at the head of that
 * source's work list, and making the source due means the next minute-ly sweep
 * picks it up — so creating a customer with its registration number fills its
 * external columns inside about a minute, with no code in the create path.
 *
 * COST IS THE CONSTRAINT here, because this runs on the 15 s maintenance sweep
 * behind the memory pipeline. Two things keep it cheap: the source list is read
 * once per team per `CACHE_TTL_MS` and held in memory (there are single digits
 * of lookup sources per team, and their `args` change about never), and the
 * marking is one statement per AFFECTED source — zero statements on the
 * overwhelming majority of sweeps, where no team has a lookup source at all.
 */

interface LookupSourceKeys {
  id: string;
  collectionId: string;
  /**
   * Field keys this source READS — what a diff is matched against. The
   * arguments' `{"$field"}` bindings, plus the match column of a walked
   * source, because a record whose key just changed belongs to a different
   * upstream row than it did a second ago.
   */
  keys: string[];
  /**
   * Whether an edit may make this source due IMMEDIATELY.
   *
   * Only a per-record source. It answers about the records it is given, so one
   * edit is one call and asking now is the whole reason the column feels live.
   * A walked source answers by reading the app's list — one edit would cost
   * every page of it — so the record is marked `pending` and collected by the
   * next run that was going to happen anyway, or by a refresh somebody asked
   * for. The UI says so where the column is chosen.
   */
  read: SyncReadStrategy;
}

/**
 * Teams' `columns` sources, cached in process.
 *
 * A minute rather than the sweep's fifteen seconds: the worst case of a stale
 * entry is that a source created in the last minute misses one invalidation
 * cycle, and its own schedule covers the record anyway. The worst case of NOT
 * caching is one query per team per fifteen seconds, forever, to learn that
 * nothing changed.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; sources: LookupSourceKeys[] }>();

/** Test hook, and what an edit to a source calls so it takes effect at once. */
export const invalidateColumnSourceCache = (teamId?: string): void => {
  if (teamId === undefined) cache.clear();
  else cache.delete(teamId);
};

const lookupSourcesForTeam = async (
  teamId: string,
): Promise<LookupSourceKeys[]> => {
  const cached = cache.get(teamId);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.sources;
  }
  const rows = await db.query.collectionSyncSources.findMany({
    where: { teamId, kind: "columns", enabled: true },
    columns: {
      id: true,
      collectionId: true,
      args: true,
      matchFieldKey: true,
    },
  });
  const sources = rows
    .map((row) => ({
      id: row.id,
      collectionId: row.collectionId,
      keys: [
        ...syncArgFieldKeys(row.args),
        ...(row.matchFieldKey === null ? [] : [row.matchFieldKey]),
      ],
      read: syncReadStrategy(row.args),
    }))
    .filter((source) => source.keys.length > 0);
  cache.set(teamId, { at: Date.now(), sources });
  return sources;
};

export interface RecordChange {
  recordId: string;
  teamId: string;
  /** Keys the diff touched. Empty ⇒ a create, which is matched on any key. */
  changedKeys: string[];
  /** The writer, so a source cannot invalidate its own write. */
  agentKey: string | null;
}

/**
 * Mark every record whose change a lookup source cares about, and make those
 * sources due. Returns how many (record, source) pairs were queued.
 */
export const invalidateColumnSources = async (
  changes: readonly RecordChange[],
): Promise<number> => {
  if (changes.length === 0) return 0;

  const teamIds = [...new Set(changes.map((change) => change.teamId))];
  // Record ids to mark, per source.
  const bySource = new Map<
    string,
    { collectionId: string; read: SyncReadStrategy; ids: Set<string> }
  >();

  for (const teamId of teamIds) {
    const sources = await lookupSourcesForTeam(teamId);
    if (sources.length === 0) continue;
    for (const change of changes) {
      if (change.teamId !== teamId) continue;
      for (const source of sources) {
        // A source must not answer its own writing. Filling a record's external
        // columns emits `record.updated`, and without this that event would mark
        // the record pending again — a loop that costs one upstream call per
        // record per sweep, forever. Another source's write is a real change and
        // is NOT filtered: a table sync that rewrites the bound key should make
        // the lookup re-ask.
        if (change.agentKey === connectorAgentKey(source.id)) continue;
        // A create carries every key it set; an update carries only what moved.
        // Either way the question is the same — does this touch what the
        // arguments read?
        if (
          change.changedKeys.length > 0 &&
          !source.keys.some((key) => change.changedKeys.includes(key))
        ) {
          continue;
        }
        const entry = bySource.get(source.id) ?? {
          collectionId: source.collectionId,
          read: source.read,
          ids: new Set<string>(),
        };
        entry.ids.add(change.recordId);
        bySource.set(source.id, entry);
      }
    }
  }
  if (bySource.size === 0) return 0;

  let queued = 0;
  const dueSourceIds: string[] = [];
  for (const [sourceId, entry] of bySource) {
    // The collection predicate lives in the STATEMENT rather than in a lookup
    // here: a record's collection is a column, and asking Postgres for it costs
    // nothing on top of the insert while reading it up front would be a second
    // query per sweep.
    const result = await db.execute(sql`
      INSERT INTO record_sync_state (record_id, sync_source_id, status, synced_at)
      SELECT r.id, ${sourceId}::uuid, 'pending'::record_sync_status, now()
        FROM collection_records r
       WHERE r.id = ANY(${sql.param([...entry.ids])}::uuid[])
         AND r.collection_id = ${entry.collectionId}::uuid
      ON CONFLICT (record_id, sync_source_id) DO UPDATE
         SET status = 'pending'::record_sync_status
      RETURNING record_id`);
    if (result.rows.length === 0) continue;
    queued += result.rows.length;
    // The `pending` rows are written for BOTH reads — they are what a run of
    // either shape prioritises. What only a per-record source earns is the
    // right to run NOW: see `read` on `LookupSourceKeys`.
    if (entry.read === "row") dueSourceIds.push(sourceId);
  }

  if (dueSourceIds.length > 0) {
    // Due NOW, but only when nothing holds the claim — a run already in flight
    // will have its `next_run_at` rewritten by `scheduleNextRun` when it ends,
    // and the `pending` rows above are what actually carry the request across.
    await db.execute(sql`
      UPDATE collection_sync_sources
         SET next_run_at = now()
       WHERE id = ANY(${sql.param(dueSourceIds)}::uuid[])
         AND enabled
         AND claimed_at IS NULL`);
  }
  return queued;
};
