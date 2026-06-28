import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
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
import { linkTypes, links, objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { RecordFilter } from "../../schemas/ontology";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { computeRelationRollupValues } from "../object-schema/computed";
import { qualifiedObjectTable } from "../object-schema/identifiers";
import { readRecordDataBatch } from "../object-schema/record-io";
import { recordSharedExists, teamHasTypeGrant } from "../object-sharing/access";

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

const resolveSortExpression = (sortBy: string, objectTypeId: string) => {
  if (sortBy.startsWith("field:")) {
    const key = sortBy.slice("field:".length);
    if (SLUG.test(key)) {
      const table = qualifiedObjectTable(objectTypeId);
      return sql`(SELECT e.${sql.raw(`"${key}"`)} FROM ${sql.raw(table)} e WHERE e."id" = ${objectRecords.id})`;
    }
    return objectRecords.createdAt;
  }
  return (
    SORTABLE_COLUMNS[sortBy as keyof typeof SORTABLE_COLUMNS] ??
    objectRecords.createdAt
  );
};

/**
 * Translate one field filter into an `EXISTS` predicate over the type's
 * extension table — now that field values are real typed columns, comparisons
 * are direct (no JSONB casts or regex guards). `money` compares its
 * `<key>_amount` column; `multi_select` membership uses `= ANY(col)`. Keys are
 * slug-guarded; values parameterized. Returns null for unsupported shapes.
 */
const buildFilterCondition = (
  f: RecordFilter,
  objectTypeId: string,
  fieldType?: FieldDefinitionType,
): SQL | null => {
  if (!SLUG.test(f.key)) return null;
  const table = sql.raw(qualifiedObjectTable(objectTypeId));
  const isMoney = fieldType === "money";
  const isMulti = fieldType === "multi_select";
  const colName = isMoney ? `${f.key}_amount` : f.key;
  const col = sql.raw(`e."${colName}"`);
  const wrap = (pred: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM ${table} e WHERE e."id" = ${objectRecords.id} AND ${pred})`;

  switch (f.op) {
    case "is_empty":
      return wrap(sql`${col} IS NULL`);
    case "is_not_empty":
      return wrap(sql`${col} IS NOT NULL`);
    case "is_true":
      return wrap(sql`${col} = true`);
    case "is_false":
      return wrap(sql`${col} = false`);
    case "eq": {
      const v = f.value;
      if (typeof v === "boolean") return wrap(sql`${col} = ${v}`);
      if (v === undefined || Array.isArray(v)) return null;
      if (isMoney && typeof v === "number") return wrap(sql`${col} = ${v}`);
      return wrap(sql`${col}::text = ${String(v)}`);
    }
    case "neq": {
      const v = f.value;
      if (v === undefined || Array.isArray(v) || typeof v === "boolean")
        return null;
      if (isMoney && typeof v === "number")
        return wrap(sql`${col} IS DISTINCT FROM ${v}`);
      return wrap(sql`${col}::text IS DISTINCT FROM ${String(v)}`);
    }
    case "contains": {
      const v = f.value;
      if (typeof v !== "string") return null;
      if (isMulti)
        return wrap(sql`${sql.raw(`e."${f.key}"`)} @> ARRAY[${v}]::text[]`);
      return wrap(sql`${col}::text ILIKE ${`%${v}%`}`);
    }
    case "in": {
      const v = f.value;
      if (!Array.isArray(v) || v.length === 0) return null;
      return wrap(sql`${col}::text = ANY(${v.map((x) => String(x))})`);
    }
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const v = f.value;
      if (v === undefined || Array.isArray(v) || typeof v === "boolean")
        return null;
      const opSql =
        f.op === "gt"
          ? sql`>`
          : f.op === "lt"
            ? sql`<`
            : f.op === "gte"
              ? sql`>=`
              : sql`<=`;
      return wrap(sql`${col} ${opSql} ${v}`);
    }
    default:
      return null;
  }
};

/**
 * List a type's records for a team. Defaults to `confirmed` only (the trust
 * model: AI suggestions stay hidden until reviewed) and newest-first. `search`
 * runs full-text over the maintained `search_vector` via `plainto_tsquery`;
 * `sortBy` / `sortDir` drive server-side ordering. Paginated; returns the page
 * plus the total count for the active filter. Each record's `data` is
 * reconstructed from its typed columns in one batch query.
 */
export const listObjectRecords = async (data: {
  teamId: string;
  objectTypeId: string;
  status?: OntologyStatus;
  search?: string;
  filters?: RecordFilter[];
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  withLinks?: boolean;
  // Resolve the 1:1 mirror record of an uploaded document (the attachment
  // field links to this mirror, not the drive `documentId`).
  documentId?: string;
}): Promise<{ count: number; data: ObjectRecordListItem[] }> => {
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

  // A type's fields live under its OWNER team. For an own type that's the
  // viewing team; for a shared-in foreign type it's the type's `teamId`; for a
  // system type (`teamId IS NULL`) the viewer's own copy. Resolve the owner so
  // field defs / relation projections render a foreign type correctly.
  const type = await db.query.objectTypes.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: objectTypeId },
  });
  const ownerTeamId = type?.teamId ?? teamId;
  const organizationId = type?.organizationId;
  const isForeign = type?.teamId != null && type.teamId !== teamId;
  // A type-level grant exposes EVERY record of the type; otherwise a foreign
  // viewer sees only the records individually shared with it.
  const hasTypeGrant =
    isForeign && organizationId !== undefined
      ? await teamHasTypeGrant({ objectTypeId, teamId, organizationId })
      : false;

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: ownerTeamId,
    objectTypeId,
  });

  const conditions = [
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, status),
  ];
  // Visibility arm (mirrors the RLS): own/system → the viewer's rows;
  // grant-covered foreign type → all its rows; otherwise → record-shared rows.
  if (!isForeign) {
    conditions.push(eq(objectRecords.teamId, teamId));
  } else if (!hasTypeGrant && organizationId !== undefined) {
    conditions.push(recordSharedExists(teamId, organizationId));
  }
  if (documentId) {
    conditions.push(eq(objectRecords.documentId, documentId));
  }
  if (search && search.trim().length > 0) {
    const q = search.trim();
    const like = `%${q}%`;
    conditions.push(
      sql`(${objectRecords.label} ILIKE ${like} OR ${objectRecords.normalizedLabel} ILIKE ${like} OR ${objectRecords.searchVector} @@ plainto_tsquery('simple', ${q}))`,
    );
  }
  if (filters.length > 0) {
    const fieldTypeByKey = new Map<string, FieldDefinitionType>(
      fieldDefs.map((d) => [d.key, d.type]),
    );
    for (const f of filters) {
      const cond = buildFilterCondition(
        f,
        objectTypeId,
        fieldTypeByKey.get(f.key),
      );
      if (cond) conditions.push(cond);
    }
  }
  const whereClause = and(...conditions);
  const offset = Math.max(0, page * limit);

  const sortExpr = resolveSortExpression(sortBy, objectTypeId);
  const orderBy = sortDir === "asc" ? asc(sortExpr) : desc(sortExpr);

  const [items, [totalResult]] = await Promise.all([
    db
      .select()
      .from(objectRecords)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(objectRecords).where(whereClause),
  ]);

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
    return { count: totalResult?.total ?? 0, data: enriched };
  }

  const summaries = await fetchOutgoingLinkSummaries(recordIds);
  return {
    count: totalResult?.total ?? 0,
    data: enriched.map((r) => ({
      ...r,
      outgoingLinks: summaries[r.id] ?? [],
    })),
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
