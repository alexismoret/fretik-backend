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
import type { ObjectRecord, OntologyStatus } from "../../db/schema";
import { linkTypes, links, objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { RecordFilter } from "../../schemas/ontology";

/**
 * Lightweight outgoing-relation summary attached to list rows (Twenty-style
 * relation cells). Just enough to render a chip that links to the other record.
 */
export type RecordLinkSummary = {
  id: string;
  linkType: { key: string; label: string };
  toRecord: { id: string; label: string; objectTypeId: string };
};

export type ObjectRecordListItem = ObjectRecord & {
  outgoingLinks?: RecordLinkSummary[];
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

/**
 * Resolve a `sortBy` token to an orderable expression. Structural columns
 * (`label` / `createdAt` / `updatedAt`) map to real columns; `field:<key>`
 * sorts by a dynamic field via `data ->> key`. The key is parameterized (a
 * value to the `->>` operator, never interpolated into SQL) AND shape-guarded
 * to a slug, so a malformed `sortBy` falls back to `createdAt` rather than
 * reaching the database. No DDL-injection surface.
 */
const SORTABLE_COLUMNS = {
  label: objectRecords.label,
  createdAt: objectRecords.createdAt,
  updatedAt: objectRecords.updatedAt,
} as const;

const SLUG = /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/;

const resolveSortExpression = (sortBy: string) => {
  if (sortBy.startsWith("field:")) {
    const key = sortBy.slice("field:".length);
    if (SLUG.test(key)) return sql`(${objectRecords.data} ->> ${key})`;
    return objectRecords.createdAt;
  }
  return (
    SORTABLE_COLUMNS[sortBy as keyof typeof SORTABLE_COLUMNS] ??
    objectRecords.createdAt
  );
};

/**
 * Translate one field filter into a safe SQL predicate over the JSONB `data`
 * column. Keys are slug-guarded; values are parameterized. Numeric comparisons
 * are CASE-guarded by a regex so a non-numeric row never aborts the cast; date
 * comparisons ride ISO text ordering. Returns null for unsupported shapes so
 * the caller drops the filter rather than erroring the list.
 */
const textExpr = (key: string): SQL => sql`(${objectRecords.data} ->> ${key})`;

const numericGuarded = (key: string): SQL =>
  sql`CASE WHEN (${objectRecords.data} ->> ${key}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${objectRecords.data} ->> ${key})::numeric END`;

const buildFilterCondition = (f: RecordFilter): SQL | null => {
  if (!SLUG.test(f.key)) return null;
  const t = textExpr(f.key);
  switch (f.op) {
    case "is_empty":
      return sql`((${objectRecords.data} ->> ${f.key}) IS NULL OR (${objectRecords.data} ->> ${f.key}) = '')`;
    case "is_not_empty":
      return sql`((${objectRecords.data} ->> ${f.key}) IS NOT NULL AND (${objectRecords.data} ->> ${f.key}) <> '')`;
    case "is_true":
      return sql`(${objectRecords.data} -> ${f.key})::boolean = true`;
    case "is_false":
      return sql`(${objectRecords.data} -> ${f.key})::boolean = false`;
    case "eq": {
      const v = f.value;
      if (typeof v === "boolean")
        return sql`(${objectRecords.data} -> ${f.key})::boolean = ${v}`;
      if (v === undefined || Array.isArray(v)) return null;
      return sql`${t} = ${String(v)}`;
    }
    case "neq": {
      const v = f.value;
      if (v === undefined || Array.isArray(v) || typeof v === "boolean")
        return null;
      return sql`${t} IS DISTINCT FROM ${String(v)}`;
    }
    case "contains": {
      const v = f.value;
      if (typeof v !== "string") return null;
      return sql`(${t} ILIKE ${`%${v}%`} OR (${objectRecords.data} -> ${f.key}) @> ${JSON.stringify([v])}::jsonb)`;
    }
    case "in": {
      const v = f.value;
      if (!Array.isArray(v) || v.length === 0) return null;
      return sql`${t} = ANY(${v})`;
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
      if (typeof v === "number")
        return sql`${numericGuarded(f.key)} ${opSql} ${v}`;
      return sql`${t} ${opSql} ${v}`;
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
 * plus the total count for the active filter.
 *
 * `page` is zero-indexed and `limit` defaults to 25 to match the shared
 * `paramsListSchema` the API handlers validate against (`offset = page *
 * limit`).
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
  } = data;

  const conditions = [
    eq(objectRecords.teamId, teamId),
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, status),
  ];
  if (search && search.trim().length > 0) {
    const q = search.trim();
    const like = `%${q}%`;
    // Partial (ILIKE) match on the label so typing mid-word matches, OR the
    // full-text vector for multi-word / field-content matches.
    conditions.push(
      sql`(${objectRecords.label} ILIKE ${like} OR ${objectRecords.normalizedLabel} ILIKE ${like} OR ${objectRecords.searchVector} @@ plainto_tsquery('simple', ${q}))`,
    );
  }
  for (const f of filters) {
    const cond = buildFilterCondition(f);
    if (cond) conditions.push(cond);
  }
  const whereClause = and(...conditions);
  const offset = Math.max(0, page * limit);

  const sortExpr = resolveSortExpression(sortBy);
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

  if (!withLinks) {
    return { count: totalResult?.total ?? 0, data: items };
  }

  const summaries = await fetchOutgoingLinkSummaries(items.map((r) => r.id));
  return {
    count: totalResult?.total ?? 0,
    data: items.map((r) => ({ ...r, outgoingLinks: summaries[r.id] ?? [] })),
  };
};

/**
 * Fetch a single record with its outgoing + incoming links and the records on
 * the other end of each edge (plus the link type carrying the semantics).
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
  return record;
};
