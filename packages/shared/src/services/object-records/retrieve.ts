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
  FieldDefinitionType,
  ObjectRecord,
  OntologyStatus,
} from "../../db/schema";
import {
  fieldDefinitions,
  linkTypes,
  links,
  objectRecords,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { RecordFilter } from "../../schemas/ontology";
import { typedViewName } from "../object-types/sync-typed-view";

/** Field-key grammar, re-validated before composing any view-column identifier. */
const SAFE_FIELD_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Project the values that don't live in `object_records.data` — relations as
 * `[{id,label}]` and rollup aggregates — by reading the team's typed view for a
 * page of records. The view is the single source of truth (identical to the AI
 * SQL surface), and the API role owns it (it ran the CREATE), so no extra grant
 * is needed. Best-effort: a missing view or unsafe key yields an empty map
 * rather than failing the list. Column names + view name are slug-revalidated
 * before embedding (anti-DDL-injection boundary); record ids are parameterized.
 */
const loadComputedFieldValues = async (input: {
  teamId: string;
  objectTypeId: string;
  recordIds: string[];
}): Promise<Map<string, Record<string, unknown>>> => {
  const empty = new Map<string, Record<string, unknown>>();
  if (input.recordIds.length === 0) return empty;

  const type = await db.query.objectTypes.findFirst({
    columns: { key: true },
    where: { id: input.objectTypeId },
  });
  if (!type) return empty;

  const defs = await db
    .select({ key: fieldDefinitions.key, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, input.teamId),
        eq(fieldDefinitions.objectTypeId, input.objectTypeId),
        eq(fieldDefinitions.enabled, true),
      ),
    );
  const cols = defs
    .filter(
      (d) =>
        (d.type === "relation" || d.type === "rollup") &&
        SAFE_FIELD_KEY.test(d.key),
    )
    .map((d) => d.key);
  if (cols.length === 0) return empty;

  try {
    const viewName = typedViewName(type.key, input.teamId);
    const selectList = ["_id", ...cols].join(", ");
    const res = await db.execute(
      sql`SELECT ${sql.raw(selectList)} FROM ${sql.raw(viewName)} WHERE _id = ANY(${sql.param(input.recordIds)}::uuid[])`,
    );
    const map = new Map<string, Record<string, unknown>>();
    for (const row of res.rows) {
      const id = String(row._id);
      const values: Record<string, unknown> = {};
      for (const c of cols) values[c] = row[c];
      map.set(id, values);
    }
    return map;
  } catch {
    return empty;
  }
};

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
  // Field values that don't live in `data`: relations as `[{id,label}]` and
  // rollup aggregates, projected from the team's typed view (the same surface
  // the AI reads) so the UI and the AI never disagree.
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

/**
 * `money` stores `{ amount, currencyCode }`, so its numeric value sits one level
 * deeper than a scalar field. Guarded the same way as `numericGuarded` so a
 * malformed amount never aborts the cast — lets users filter "costs more / less
 * than" on the amount.
 */
const moneyAmountGuarded = (key: string): SQL =>
  sql`CASE WHEN (${objectRecords.data} -> ${key} ->> 'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${objectRecords.data} -> ${key} ->> 'amount')::numeric END`;

const buildFilterCondition = (
  f: RecordFilter,
  fieldType?: FieldDefinitionType,
): SQL | null => {
  if (!SLUG.test(f.key)) return null;
  const isMoney = fieldType === "money";
  const t = textExpr(f.key);
  switch (f.op) {
    case "is_empty":
      return isMoney
        ? sql`(${objectRecords.data} -> ${f.key} ->> 'amount') IS NULL`
        : sql`((${objectRecords.data} ->> ${f.key}) IS NULL OR (${objectRecords.data} ->> ${f.key}) = '')`;
    case "is_not_empty":
      return isMoney
        ? sql`(${objectRecords.data} -> ${f.key} ->> 'amount') IS NOT NULL`
        : sql`((${objectRecords.data} ->> ${f.key}) IS NOT NULL AND (${objectRecords.data} ->> ${f.key}) <> '')`;
    case "is_true":
      return sql`(${objectRecords.data} -> ${f.key})::boolean = true`;
    case "is_false":
      return sql`(${objectRecords.data} -> ${f.key})::boolean = false`;
    case "eq": {
      const v = f.value;
      if (typeof v === "boolean")
        return sql`(${objectRecords.data} -> ${f.key})::boolean = ${v}`;
      if (v === undefined || Array.isArray(v)) return null;
      if (isMoney && typeof v === "number")
        return sql`${moneyAmountGuarded(f.key)} = ${v}`;
      return sql`${t} = ${String(v)}`;
    }
    case "neq": {
      const v = f.value;
      if (v === undefined || Array.isArray(v) || typeof v === "boolean")
        return null;
      if (isMoney && typeof v === "number")
        return sql`${moneyAmountGuarded(f.key)} IS DISTINCT FROM ${v}`;
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
      if (isMoney && typeof v === "number")
        return sql`${moneyAmountGuarded(f.key)} ${opSql} ${v}`;
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

  const conditions = [
    eq(objectRecords.teamId, teamId),
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, status),
  ];
  if (documentId) {
    conditions.push(eq(objectRecords.documentId, documentId));
  }
  if (search && search.trim().length > 0) {
    const q = search.trim();
    const like = `%${q}%`;
    // Partial (ILIKE) match on the label so typing mid-word matches, OR the
    // full-text vector for multi-word / field-content matches.
    conditions.push(
      sql`(${objectRecords.label} ILIKE ${like} OR ${objectRecords.normalizedLabel} ILIKE ${like} OR ${objectRecords.searchVector} @@ plainto_tsquery('simple', ${q}))`,
    );
  }
  if (filters.length > 0) {
    // Some filters are type-aware (e.g. `money` compares the nested amount), so
    // resolve each key's field type once before building the predicates.
    const defs = await db
      .select({
        key: fieldDefinitions.key,
        type: fieldDefinitions.type,
      })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.teamId, teamId),
          eq(fieldDefinitions.objectTypeId, objectTypeId),
        ),
      );
    const fieldTypeByKey = new Map<string, FieldDefinitionType>(
      defs.map((d) => [d.key, d.type]),
    );
    for (const f of filters) {
      const cond = buildFilterCondition(f, fieldTypeByKey.get(f.key));
      if (cond) conditions.push(cond);
    }
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

  const recordIds = items.map((r) => r.id);
  const computed = await loadComputedFieldValues({
    teamId,
    objectTypeId,
    recordIds,
  });
  const withComputed = items.map((r) => ({
    ...r,
    computed: computed.get(r.id) ?? {},
  }));

  if (!withLinks) {
    return { count: totalResult?.total ?? 0, data: withComputed };
  }

  const summaries = await fetchOutgoingLinkSummaries(recordIds);
  return {
    count: totalResult?.total ?? 0,
    data: withComputed.map((r) => ({
      ...r,
      outgoingLinks: summaries[r.id] ?? [],
    })),
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
  // Relation + rollup values from the typed view (same source as the AI).
  const computed = record.teamId
    ? ((
        await loadComputedFieldValues({
          teamId: record.teamId,
          objectTypeId: record.objectTypeId,
          recordIds: [record.id],
        })
      ).get(record.id) ?? {})
    : {};
  return { ...record, computed };
};
