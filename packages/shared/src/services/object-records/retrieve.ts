import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import db from "../../db";
import type {
  FieldDefinition,
  FieldDefinitionType,
  ObjectRecordWithData,
  OntologyStatus,
} from "../../db/schema";
import { links, linkTypes, objectRecords } from "../../db/schema";
import { idCursor } from "../../lib/cursor";
import { notFound, throwHttpError } from "../../lib/errors";
import type { RecordFilter } from "../../schemas/ontology";
import { normalizeEntityName } from "../../utils/normalizeEntityName";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { columnsForField } from "../object-schema/columns";
import { computeRelationRollupValues } from "../object-schema/computed";
import { buildFieldFilterPredicate } from "../object-schema/field-filter";
import { qualifiedObjectTable } from "../object-schema/identifiers";
import { indexesTextPrefix, TEXT_INDEX_PREFIX } from "../object-schema/indexes";
import { noteIndexWanted } from "../object-schema/reconcile-indexes";
import { readRecordDataBatch } from "../object-schema/record-io";
import { recordVisibilityCondition, resolveRecordTypeScope } from "./scope";

/**
 * Lightweight outgoing-relation summary attached to list rows (Twenty-style
 * relation cells). Just enough to render a chip that links to the other record.
 */
export type RecordLinkSummary = {
  id: string;
  linkType: { key: string; label: string };
  toRecord: { id: string; label: string; objectTypeId: string };
};

export type ObjectRecordListItem = ObjectRecordWithData & {
  outgoingLinks?: RecordLinkSummary[];
  // Graph-derived values that aren't physical columns: relations as `[{id,label}]`
  // and rollup aggregates, computed from `links` on demand (same logic as the AI
  // path) so the UI and the AI never disagree.
  computed?: Record<string, unknown>;
};

/**
 * Batch-fetch active outgoing links for a page of records in ONE query, grouped
 * by source record id. Avoids N+1 when the views ask for `withLinks`.
 */
const fetchOutgoingLinkSummaries = async (
  recordIds: string[],
): Promise<Record<string, RecordLinkSummary[]>> => {
  if (recordIds.length === 0) return {};
  const toRec = aliasedTable(objectRecords, "to_rec");
  const rows = await db
    .select({
      fromRecordId: links.fromRecordId,
      id: links.id,
      linkTypeKey: linkTypes.key,
      linkTypeLabel: linkTypes.label,
      toId: toRec.id,
      toLabel: toRec.label,
      toObjectTypeId: toRec.objectTypeId,
    })
    .from(links)
    .innerJoin(linkTypes, eq(links.linkTypeId, linkTypes.id))
    .innerJoin(toRec, eq(links.toRecordId, toRec.id))
    .where(
      and(inArray(links.fromRecordId, recordIds), isNull(links.invalidatedAt)),
    );

  const grouped: Record<string, RecordLinkSummary[]> = {};
  for (const r of rows) {
    (grouped[r.fromRecordId] ??= []).push({
      id: r.id,
      linkType: { key: r.linkTypeKey, label: r.linkTypeLabel },
      toRecord: {
        id: r.toId,
        label: r.toLabel,
        objectTypeId: r.toObjectTypeId,
      },
    });
  }
  return grouped;
};

const SLUG = /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/;

/**
 * Resolve a `sortBy` token to an orderable expression. Structural columns
 * (`label`/`createdAt`/`updatedAt`) map to registry columns; `field:<key>` sorts
 * by the record's typed value via a correlated subquery on its extension table.
 * The key is slug-guarded so a malformed `sortBy` falls back to `createdAt`.
 */
const SORTABLE_COLUMNS = {
  label: objectRecords.label,
  createdAt: objectRecords.createdAt,
  updatedAt: objectRecords.updatedAt,
} as const;

/**
 * System-property field types → the `object_records` registry column they
 * project. Read-only metadata surfaced as fields; both filter and sort target
 * the registry row directly (no extension column exists for them).
 */
const SYSTEM_FIELD_COLUMN: Partial<Record<FieldDefinitionType, SQL>> = {
  created_time: sql`${objectRecords.createdAt}`,
  last_edited_time: sql`${objectRecords.updatedAt}`,
  created_by: sql`${objectRecords.createdByUserId}`,
  last_edited_by: sql`${objectRecords.updatedByUserId}`,
};

const resolveSortExpression = (
  sortBy: string,
  objectTypeId: string,
  fieldType?: FieldDefinitionType,
) => {
  if (sortBy.startsWith("field:")) {
    // A system property sorts on its registry column, not an extension one.
    const sys = fieldType ? SYSTEM_FIELD_COLUMN[fieldType] : undefined;
    if (sys) return sys;
    const key = sortBy.slice("field:".length);
    if (SLUG.test(key)) {
      const table = qualifiedObjectTable(objectTypeId);
      // `money` is stored across `<key>_amount` + `<key>_currency` — order by
      // the numeric amount column (mirrors `buildFilterCondition`).
      const colName = fieldType === "money" ? `${key}_amount` : key;
      return sql`(SELECT e.${sql.raw(`"${colName}"`)} FROM ${sql.raw(table)} e WHERE e."id" = ${objectRecords.id})`;
    }
    return objectRecords.createdAt;
  }
  return (
    SORTABLE_COLUMNS[sortBy as keyof typeof SORTABLE_COLUMNS] ??
    objectRecords.createdAt
  );
};

/** Alias the extension table takes when it is joined for sorting. */
const EXT = "e";

/** Field types with no stored column — ordering by one is a caller mistake. */
const UNSORTABLE_FIELD_TYPES = new Set<FieldDefinitionType>([
  "relation",
  "rollup",
]);

/**
 * The extension column a `field:<key>` sort targets, or null when the sort must
 * stay on the registry (structural column, system property, unknown or computed
 * field, or a malformed key).
 */
const extensionSortColumn = (
  sortBy: string,
  field?: FieldDefinition,
): { column: string; sqlType: string } | null => {
  if (!sortBy.startsWith("field:")) return null;
  if (field && SYSTEM_FIELD_COLUMN[field.type]) return null;
  if (field && UNSORTABLE_FIELD_TYPES.has(field.type)) return null;
  const key = sortBy.slice("field:".length);
  if (!SLUG.test(key) || !field) return null;
  // `money` spreads over `<key>_amount` + `<key>_currency`; the amount is what
  // orders, and `columnsForField` puts it first.
  const [column] = columnsForField(field);
  return column ? { column: column.name, sqlType: column.sqlType } : null;
};

/**
 * The ORDER BY keys for one extension column, in index order.
 *
 * A text column is indexed on `left(col, N)` — indexing it whole would make
 * INSERT fail past the btree tuple limit. Leading the sort with the same
 * expression is what lets Postgres walk that index instead of sorting the
 * table; the full column follows to break ties inside a shared prefix, which
 * makes the pair EXACTLY `ORDER BY col` (verified row-for-row on 200k rows).
 */
const extensionSortKeys = (target: {
  column: string;
  sqlType: string;
}): SQL[] => {
  const column = sql.raw(`${EXT}."${target.column}"`);
  if (!indexesTextPrefix(target.sqlType)) return [column];
  return [
    sql.raw(`left(${EXT}."${target.column}", ${TEXT_INDEX_PREFIX})`),
    column,
  ];
};

/**
 * Scope predicates on the extension table, mirroring the registry's own.
 *
 * They are logically redundant — `_team_id` / `_status` are denormalized copies
 * kept in sync on every write — but they are what makes the sort fast: the
 * per-field index is `(_team_id, _status, <col>)`, so without an equality on its
 * two leading columns Postgres cannot walk it in `<col>` order. Measured on 200k
 * rows: 1714 ms with the correlated subquery, 460 ms joined without these
 * predicates, 28 ms with them.
 *
 * Only sound for a type the viewing team OWNS. On a shared-in type, records may
 * legitimately belong to other teams (`inherit OR shared`), so pinning
 * `_team_id` to the viewer would silently HIDE rows — a correctness bug, not a
 * leak. Foreign types keep the registry-only path.
 */
const extensionScopeCondition = (input: {
  teamId: string;
  status: OntologyStatus;
}): SQL =>
  sql`${sql.raw(`${EXT}."_team_id"`)} = ${input.teamId}::uuid AND ${sql.raw(`${EXT}."_status"`)} = ${input.status}::ontology_status`;

/**
 * Wrap the shared field-filter predicate in an `EXISTS` correlated to the
 * record's row on its extension table. The predicate itself (the per-operator
 * SQL over `e."col"`) lives in `buildFieldFilterPredicate` — the single source
 * of truth shared with the drive's document filter.
 */
const buildFilterCondition = (
  f: RecordFilter,
  objectTypeId: string,
  fieldType?: FieldDefinitionType,
): SQL | null => {
  // System properties filter on the registry row itself — the predicate is built
  // against the registry column and needs no extension EXISTS.
  const sysCol = fieldType ? SYSTEM_FIELD_COLUMN[fieldType] : undefined;
  if (sysCol) return buildFieldFilterPredicate(f, fieldType, sysCol);

  const pred = buildFieldFilterPredicate(f, fieldType);
  if (!pred) return null;
  const table = sql.raw(qualifiedObjectTable(objectTypeId));
  return sql`EXISTS (SELECT 1 FROM ${table} e WHERE e."id" = ${objectRecords.id} AND ${pred})`;
};

/**
 * List a type's records for a team. Defaults to `confirmed` only (the trust
 * model: AI suggestions stay hidden until reviewed) and newest-first. `search`
 * runs full-text over the maintained `search_vector` via `plainto_tsquery`;
 * `sortBy` / `sortDir` drive server-side ordering. Paginated; returns the page
 * plus the total count for the active filter. Each record's `data` is
 * reconstructed from its typed columns in one batch query.
 *
 * Two ways to page, and the caller picks by what it renders:
 *  - `paginate: "page"` (the default) — `page`/`offset` + an exact `count`,
 *    for numbered pages and "X–Y of Z".
 *  - `paginate: "cursor"` — `cursor` + `nextCursor`, for a list that only ever
 *    walks forward. The total is then neither computed nor returned, which is
 *    the point: a scrolling lane was paying a full `COUNT(*)` per page to
 *    answer a question `limit + 1` answers for free.
 *
 * An explicit mode rather than "a cursor was passed", because the FIRST page of
 * a walk has no cursor yet — inferring the mode from its presence would make
 * that page pay the count it is trying to avoid.
 *
 * The walk only applies under the DEFAULT order (`createdAt` desc). Any other
 * `sortBy`/`sortDir` silently keeps the offset path — see `walking` below for
 * why that restriction is not laziness.
 */
export const listObjectRecords = async (data: {
  teamId: string;
  objectTypeId: string;
  status?: OntologyStatus;
  search?: string;
  filters?: RecordFilter[];
  page?: number;
  /** Row offset. Takes precedence over `page`, which it generalises — a caller
   *  advancing by result COUNT (the `listObjects` tool) lands between page
   *  boundaries and cannot express itself as a page number. */
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  withLinks?: boolean;
  /** `"cursor"` walks forward and skips the count. Falls back to `"page"` when
   *  the order is not the default one. */
  paginate?: "page" | "cursor";
  /** Opaque cursor from a previous `nextCursor`. Absent on the first page of a
   *  walk; one that no longer decodes restarts from the first page. */
  cursor?: string;
  // Resolve the 1:1 mirror record of an uploaded document (the attachment
  // field links to this mirror, not the drive `documentId`).
  documentId?: string;
}): Promise<{
  /** NOT computed on the walk, where it comes back as 0 — a caller that asked
   *  for `paginate: "cursor"` asked for exactly that. Read `nextCursor`. */
  count: number;
  data: ObjectRecordListItem[];
  /** Present only on the walk; null once the last row has been served. */
  nextCursor?: string | null;
}> => {
  const {
    teamId,
    objectTypeId,
    status = "confirmed",
    search,
    filters = [],
    page = 0,
    limit = 25,
    sortBy = "createdAt",
    sortDir = "desc",
    withLinks = false,
    documentId,
  } = data;

  /**
   * Walk forward instead of counting rows — only when the caller asked AND the
   * order is the default one.
   *
   * The walk orders by the primary key alone (`id DESC`), not by
   * `created_at DESC, id DESC`: the seek key and the ORDER BY must be the SAME
   * key or the walk skips rows, and only the id survives a round-trip through
   * the application exactly (see `lib/cursor`). Both are v7 ids, so the two
   * orders differ only by the gap between a transaction's start — which is
   * what `created_at`'s `now()` records — and its insert.
   *
   * Any other order pays the offset. Sorting by a FIELD could not walk anyway:
   * nullable columns with a deliberate NULL order, `money` split across two
   * columns, text keys needing a three-value cursor.
   */
  const walking =
    data.paginate === "cursor" && sortBy === "createdAt" && sortDir === "desc";
  const from = walking ? idCursor(data.cursor) : null;

  // A type's fields live under its OWNER team. For an own type that's the
  // viewing team; for a shared-in foreign type it's the type's `teamId`; for a
  // system type (`teamId IS NULL`) the viewer's own copy. Resolve the owner so
  // field defs / relation projections render a foreign type correctly.
  // Resolve the visibility scope once (owner team + sharing arm) — shared with
  // the aggregate query so both enforce the same RLS-mirroring rules.
  const scope = await resolveRecordTypeScope({ objectTypeId, teamId });
  const ownerTeamId = scope.ownerTeamId;

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: ownerTeamId,
    objectTypeId,
  });

  const conditions = [
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, status),
  ];
  const visibility = recordVisibilityCondition({ teamId, scope });
  if (visibility) conditions.push(visibility);
  if (documentId) {
    conditions.push(eq(objectRecords.documentId, documentId));
  }
  if (search && search.trim().length > 0) {
    const q = search.trim();
    // TWO arms, and every arm MUST be indexable — an OR is only as fast as its
    // slowest branch. Postgres can BitmapOr several index scans, but one branch
    // with no index forces a sequential scan of the whole type and drags the
    // indexed branches down with it. That is what the third arm did here: a
    // bare `label ILIKE '%q%'` has no index (the leading wildcard rules out a
    // btree, and no trigram index covers `label`). Measured on 200k rows, one
    // selective search: 222 ms with it, 76 ms without.
    //
    // Dropping it loses nothing. `normalized_label` is the SAME text lowercased
    // with punctuation and legal suffixes removed, and it carries the trigram
    // index — so normalising the QUERY the same way matches strictly more than
    // the raw arm did ("hapag-lloyd" now finds "Hapag Lloyd", which it did not).
    // The one case normalisation erases — a query that is ONLY a legal suffix —
    // is covered by the third arm, since `search_vector` is built from the raw
    // label plus the type's text fields.
    const normalized = normalizeEntityName(q);
    const arms = [
      sql`${objectRecords.searchVector} @@ plainto_tsquery('simple', ${q})`,
    ];
    if (normalized.length > 0) {
      arms.unshift(
        sql`${objectRecords.normalizedLabel} ILIKE ${`%${normalized}%`}`,
      );
    }
    conditions.push(sql`(${sql.join(arms, sql` OR `)})`);
  }
  const fieldTypeByKey = new Map<string, FieldDefinitionType>(
    fieldDefs.map((d) => [d.key, d.type]),
  );
  if (filters.length > 0) {
    for (const f of filters) {
      const cond = buildFilterCondition(
        f,
        objectTypeId,
        fieldTypeByKey.get(f.key),
      );
      if (cond) conditions.push(cond);
    }
  }
  if (from) conditions.push(lt(objectRecords.id, from));
  const whereClause = and(...conditions);
  const offset = Math.max(0, data.offset ?? page * limit);
  // One row past the page, on the walk only: it answers "is there another
  // page?" definitively, so the last page ends the scroll instead of costing
  // one more round-trip to discover it is empty.
  const fetchLimit = walking ? limit + 1 : limit;

  // Resurrect an index the maintenance pass dropped, if this query proves it is
  // wanted again. Free unless something WAS dropped: the check reads the field
  // definitions already loaded above (see `noteIndexWanted`).
  noteIndexWanted({
    fields: fieldDefs,
    keys: [
      ...filters.map((filter) => filter.key),
      ...(sortBy.startsWith("field:") ? [sortBy.slice("field:".length)] : []),
    ],
  });

  const sortFieldType = sortBy.startsWith("field:")
    ? fieldTypeByKey.get(sortBy.slice("field:".length))
    : undefined;

  // Sorting by a typed value used to ORDER BY a correlated subquery, which
  // Postgres evaluates per candidate row and cannot serve from an index. Join
  // the extension table instead and order on its column directly.
  //
  // No explicit `NULLS` clause, ever: a btree is `ASC NULLS LAST` /
  // `DESC NULLS FIRST`, so forcing `DESC NULLS LAST` costs a full sort
  // (measured: index scan → Seq Scan + Sort). The defaults match the index.
  const sortTarget = scope.isForeign
    ? null
    : extensionSortColumn(
        sortBy,
        fieldDefs.find((field) => `field:${field.key}` === sortBy),
      );

  const pageRows = async (): Promise<(typeof objectRecords.$inferSelect)[]> => {
    // Tie-break on the primary key so rows with an equal sort value (e.g. the
    // same `createdAt` from a bulk import) keep a deterministic order — without
    // it Postgres may reshuffle tied rows after an UPDATE, making an edited row
    // jump in the grid.
    if (!sortTarget) {
      const expression = resolveSortExpression(
        sortBy,
        objectTypeId,
        sortFieldType,
      );
      return (
        db
          .select(getTableColumns(objectRecords))
          .from(objectRecords)
          .where(whereClause)
          // On the walk, order by the seek key ALONE. Ordering by anything the
          // cursor does not carry lets rows fall between two pages.
          .orderBy(
            ...(walking
              ? [desc(objectRecords.id)]
              : [
                  sortDir === "asc" ? asc(expression) : desc(expression),
                  desc(objectRecords.id),
                ]),
          )
          .limit(fetchLimit)
          .offset(walking ? 0 : offset)
      );
    }
    const keys = extensionSortKeys(sortTarget).map((key) =>
      sortDir === "asc" ? asc(key) : desc(key),
    );
    return (
      db
        .select(getTableColumns(objectRecords))
        .from(objectRecords)
        .innerJoin(
          sql`${sql.raw(qualifiedObjectTable(objectTypeId))} ${sql.raw(EXT)}`,
          sql`${sql.raw(`${EXT}."id"`)} = ${objectRecords.id}`,
        )
        .where(and(whereClause, extensionScopeCondition({ teamId, status })))
        // Never the walk: this branch exists for `sortBy: "field:<key>"`, and
        // only the default `createdAt` order can walk.
        .orderBy(...keys, desc(objectRecords.id))
        .limit(limit)
        .offset(offset)
    );
  };

  const [rows, [totalResult]] = await Promise.all([
    pageRows(),
    // Not counted on the walk. This is THE saving: a count over the whole
    // filtered set, paid once per scrolled page, to answer a question the one
    // extra row already answers.
    walking
      ? Promise.resolve<{ total: number }[]>([])
      : db.select({ total: count() }).from(objectRecords).where(whereClause),
  ]);

  const hasMore = walking && rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (items.at(-1)?.id ?? null) : null;
  // Absent outside the walk, rather than null: a paged caller never has a
  // "next cursor", and an always-null field reads like "you are on the last
  // page".
  const walk = walking ? { nextCursor } : {};

  const recordIds = items.map((r) => r.id);
  const [dataById, computed] = await Promise.all([
    readRecordDataBatch({ objectTypeId, recordIds, fields: fieldDefs }),
    computeRelationRollupValues({
      teamId: ownerTeamId,
      objectTypeId,
      recordIds,
    }),
  ]);
  const enriched: ObjectRecordListItem[] = items.map((r) => ({
    ...r,
    data: dataById.get(r.id) ?? {},
    computed: computed.get(r.id) ?? {},
  }));

  if (!withLinks) {
    return { count: totalResult?.total ?? 0, data: enriched, ...walk };
  }

  const summaries = await fetchOutgoingLinkSummaries(recordIds);
  return {
    count: totalResult?.total ?? 0,
    data: enriched.map((r) => ({
      ...r,
      outgoingLinks: summaries[r.id] ?? [],
    })),
    ...walk,
  };
};

/**
 * Fetch a single record with its outgoing + incoming links and the records on
 * the other end of each edge (plus the link type carrying the semantics). The
 * record's typed `data` and computed (relation/rollup) values are attached.
 */
export const getObjectRecord = async (data: { id: string }) => {
  const record = await db.query.objectRecords.findFirst({
    where: { id: data.id },
    with: {
      outgoingLinks: { with: { toRecord: true, linkType: true } },
      incomingLinks: { with: { fromRecord: true, linkType: true } },
    },
  });
  if (!record) {
    return throwHttpError(404, notFound("Record not found"));
  }
  const fieldDefs: FieldDefinition[] = record.teamId
    ? await getFieldDefinitionsForTeam({
        teamId: record.teamId,
        objectTypeId: record.objectTypeId,
      })
    : [];
  const [recordData, computed] = await Promise.all([
    readRecordDataBatch({
      objectTypeId: record.objectTypeId,
      recordIds: [record.id],
      fields: fieldDefs,
    }),
    computeRelationRollupValues({
      teamId: record.teamId,
      objectTypeId: record.objectTypeId,
      recordIds: [record.id],
    }),
  ]);
  return {
    ...record,
    data: recordData.get(record.id) ?? {},
    computed: computed.get(record.id) ?? {},
  };
};
