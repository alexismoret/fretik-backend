import {
  findRecordIdsByColumnValues,
  hasAnyColumnValue,
  isMatchableField,
  matchKeyOf,
} from "../collection-schema/find-by-column";
import { noteIndexWanted } from "../collection-schema/reconcile-indexes";
import { readPath } from "./project-row";
import { loadRecordSyncStateFor, markUnseenMissing } from "./record-state";
import {
  runWalkSync,
  type RunWalkSyncInput,
  type WalkResolverFactory,
  type WalkSyncOutcome,
} from "./run-walk-sync";

/**
 * The `columns` resolver read BY LIST: the app's list is walked and each row is
 * matched to a record the team already keeps.
 *
 * This is the shape that makes a second and a third app affordable on one
 * collection. The alternative — one call per record, keyed by a `{"$field"}`
 * binding — is the same data at one request per row: 20 000 requests where this
 * costs 20. It stays for the apps that genuinely have no list for the thing
 * being asked about (a tracking status by number, an enrichment by identifier),
 * and it is the fallback, not the default.
 *
 * What it will NEVER do is create or delete a record. The rows belong to the
 * team; an app whose list is wider than their table is the normal case, and
 * those rows are counted `unmatched` and forgotten. The only thing a complete
 * walk owes the records it did not match is to say so — `missing`, which shows
 * as "no answer" beside the column and changes nothing else.
 */

export const byMatchField: WalkResolverFactory = ({
  source,
  fieldDefs,
  fields,
}) => {
  const { matchFieldKey, externalIdPath } = source;
  if (matchFieldKey === null || externalIdPath === null) {
    throw new Error(
      "this columns source has neither a match column nor a field binding, so it has no way to tell whose answer an upstream row is",
    );
  }
  const field = fieldDefs.find((def) => def.key === matchFieldKey);
  if (field === undefined || !isMatchableField(field)) {
    // Both doors refuse this, so reaching it means a row was written around
    // the service — or the column was disabled after the fact. Matching on a
    // column that cannot key would silently match nothing.
    throw new Error(
      `'${matchFieldKey}' cannot match rows: it is missing, disabled, or of a type with no single comparable value`,
    );
  }
  if (fields.some((owned) => owned.key === matchFieldKey)) {
    // Writing the column the match reads would move the target between runs.
    throw new Error(
      `'${matchFieldKey}' is how rows are matched, so this source must not also fill it`,
    );
  }

  // Every walk says it wants the index, so the pruning pass that drops indexes
  // nothing has scanned cannot take this one out from under a source that only
  // runs once a day.
  noteIndexWanted({ fields: [...fieldDefs], keys: [matchFieldKey] });

  return {
    keyOf: (row) => matchKeyOf(field, readPath(row, externalIdPath)),
    resolve: async (keys) => {
      const byKey = await findRecordIdsByColumnValues({
        collectionId: source.collectionId,
        teamId: source.teamId,
        field,
        keys,
      });
      const recordIds = [...byKey.values()].flat();
      // One state read for the whole page, by primary key. Its absence is not
      // an absence of record — it is a record this source has never answered
      // about, which the hash comparison then treats as "write it".
      const state = await loadRecordSyncStateFor(source.id, recordIds);
      return new Map(
        [...byKey].map(([key, ids]) => [
          key,
          ids.map((recordId) => {
            const row = state.get(recordId);
            return {
              recordId,
              contentHash: row?.contentHash ?? null,
              status: row?.status ?? null,
            };
          }),
        ]),
      );
    },
    unknownRows: "count",
    precheck: async () => {
      // A `columns` source is routinely declared before the `table` source
      // that fills its key has ever run. Walking an app's whole list to match
      // it against an empty column is the purest waste this engine can
      // produce: every page paid for, nothing found, repeated on every tick.
      const anyKey = await hasAnyColumnValue({
        collectionId: source.collectionId,
        teamId: source.teamId,
        field,
      });
      return anyKey ? { skip: false } : { skip: true, reason: "no_match_keys" };
    },
    afterFullWalk: async ({ walkStartedAt, counts }) => {
      counts.missingCount += await markUnseenMissing({
        syncSourceId: source.id,
        collectionId: source.collectionId,
        teamId: source.teamId,
        field,
        walkStartedAt,
      });
      // No floor and no confirmation, because there is nothing to protect
      // against: `missing` writes one status, keeps every stored value, and is
      // undone by the next walk that matches the row.
      return { kind: "applied" };
    },
  };
};

export const runColumnsWalk = async (
  input: Omit<RunWalkSyncInput, "resolver">,
): Promise<WalkSyncOutcome> =>
  await runWalkSync({ ...input, resolver: byMatchField });
