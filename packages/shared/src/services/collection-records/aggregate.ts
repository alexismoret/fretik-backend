import { and, eq, sql, type SQL } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinitionType, OntologyStatus } from "../../db/schema";
import { collectionRecords } from "../../db/schema";
import type { RecordFilter } from "../../schemas/ontology";
import type { PageDateBucket, PageMetric } from "../../schemas/pages";
import { buildFieldFilterPredicate } from "../collection-schema/field-filter";
import {
  assertSafeKey,
  qualifiedCollectionTable,
} from "../collection-schema/identifiers";
import { noteIndexWanted } from "../collection-schema/reconcile-indexes";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { recordVisibilityCondition, resolveRecordTypeScope } from "./scope";

/**
 * Generic record aggregation — the query engine behind every chart and KPI a
 * page draws. Generalises `aggregateRecordsByGroup` (kanban headers, kept
 * untouched: its contract is narrow, hot, and has no use for any of this)
 * along four axes: field filters, five aggregate functions, date bucketing,
 * and an optional second dimension for stacked/multi-series charts.
 *
 * Safety: every caller-supplied key is slug-guarded before it reaches SQL
 * (the anti-DDL-injection boundary), bucket names come from a closed enum, and
 * row visibility goes through the SAME `resolveRecordTypeScope` +
 * `recordVisibilityCondition` pair as the list query — a divergence there is a
 * data leak, which is why both paths share it.
 */

/** One aggregated row: the group, an optional series, and one key per metric. */
export type AggregateRow = Record<string, string | number | null>;

export interface AggregateResult {
  rows: AggregateRow[];
  /** True when the group cap was hit and rows were dropped. */
  truncated: boolean;
}

/**
 * Fields with no column on the extension table — grouping by one is a caller
 * mistake worth naming, not a raw `column does not exist` from Postgres.
 */
const VIRTUAL_FIELD_TYPES = new Set<FieldDefinitionType>([
  "relation",
  "rollup",
]);

/**
 * Grouping column: a plain field, a date field truncated to a bucket, or one
 * value of a `multi_select`.
 *
 * A `multi_select` is a `text[]`: casting it to text yields `{a,b}`, so records
 * group by exact COMBINATION — "12 people chose (sales, ops)" instead of the
 * histogram every caller actually wants. It is unnested through a LATERAL join
 * instead (see `lateralFor`), one row per value.
 */
const groupExpression = (
  key: string,
  fieldType?: FieldDefinitionType,
  bucket?: PageDateBucket,
): SQL => {
  if (fieldType === "multi_select")
    return sql`${sql.raw(`${lateralAlias(key)}.v`)}`;
  const column = sql.raw(`e."${key}"`);
  if (!bucket) return sql`${column}::text`;
  // `bucket` is a closed enum, never caller text.
  return sql`date_trunc('${sql.raw(bucket)}', ${column})::date::text`;
};

/** Alias of the LATERAL unnest that expands a `multi_select` dimension. */
const lateralAlias = (key: string): string => `gv_${key}`;

/**
 * `CROSS JOIN LATERAL unnest(...)` for a `multi_select` dimension, or nothing.
 * `COALESCE` to an empty array would DROP null rows (a cross join over zero
 * rows yields nothing); `LEFT JOIN LATERAL ... ON TRUE` keeps them with a null
 * value, which reads as the "unset" bucket.
 */
const lateralFor = (
  key: string,
  fieldType?: FieldDefinitionType,
): SQL | null => {
  if (fieldType !== "multi_select") return null;
  return sql`LEFT JOIN LATERAL unnest(${sql.raw(`e."${key}"`)}) AS ${sql.raw(lateralAlias(key))}(v) ON TRUE`;
};

const metricExpression = (
  metric: PageMetric,
  fieldTypes: Map<string, FieldDefinitionType>,
): SQL => {
  if (metric.fn === "count") return sql`count(*)::float8`;
  if (!metric.key) return sql`NULL`;
  const isMoney =
    metric.kind === "money" || fieldTypes.get(metric.key) === "money";
  const column = sql.raw(
    `e."${isMoney ? `${metric.key}_amount` : metric.key}"`,
  );
  switch (metric.fn) {
    // "how many different X" — the one question `count` cannot answer, and the
    // one an author previously had to fake with a transform.
    case "count_distinct":
      return sql`count(DISTINCT ${column})::float8`;
    case "sum":
      return sql`COALESCE(sum(${column}), 0)::float8`;
    case "avg":
      return sql`avg(${column})::float8`;
    case "min":
      return sql`min(${column})::float8`;
    case "max":
      return sql`max(${column})::float8`;
  }
};

export const aggregateRecords = async (data: {
  teamId: string;
  collectionId: string;
  status?: OntologyStatus;
  filters?: RecordFilter[];
  /** Field to group by. Omitted → a single scalar row (the KPI case). */
  groupBy?: string;
  /** Truncate `groupBy` (a date field) to this bucket instead of exact values. */
  dateBucket?: PageDateBucket;
  /** Second dimension — stacked bars, multi-series lines. */
  seriesBy?: string;
  metrics: PageMetric[];
  /** Max groups returned; one extra row is probed to report truncation. */
  limit?: number;
  /** `group`, `series`, or a metric `name`. */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}): Promise<AggregateResult> => {
  const {
    teamId,
    collectionId,
    status = "confirmed",
    filters = [],
    groupBy,
    dateBucket,
    seriesBy,
    metrics,
    limit = 100,
    sortBy,
    sortDir = "desc",
  } = data;

  if (groupBy) assertSafeKey(groupBy, "group key");
  if (seriesBy) assertSafeKey(seriesBy, "series key");
  for (const metric of metrics) {
    if (metric.key) assertSafeKey(metric.key, "metric key");
  }
  if (metrics.length === 0) {
    return { rows: [], truncated: false };
  }

  const definitions = await getFieldDefinitionsForTeam({
    teamId,
    collectionId,
  });
  const fieldTypes = new Map<string, FieldDefinitionType>(
    definitions.map((definition) => [definition.key, definition.type]),
  );

  // Resurrect an index the maintenance pass dropped, if this chart proves the
  // dimension is wanted again. Free unless something WAS dropped — the check
  // reads the definitions just loaded (see `noteIndexWanted`).
  noteIndexWanted({
    fields: definitions,
    keys: [
      ...filters.map((filter) => filter.key),
      ...(groupBy ? [groupBy] : []),
      ...(seriesBy ? [seriesBy] : []),
    ],
  });

  const scope = await resolveRecordTypeScope({ collectionId, teamId });
  const table = sql.raw(qualifiedCollectionTable(collectionId));

  const conditions: SQL[] = [
    eq(collectionRecords.collectionId, collectionId),
    eq(collectionRecords.status, status),
  ];
  const visibility = recordVisibilityCondition({ teamId, scope });
  if (visibility) conditions.push(visibility);

  // Filters compare columns on the extension table, which is already joined as
  // `e` below — so the predicates go straight into the WHERE, no correlated
  // EXISTS needed (unlike the list query, which has no such join).
  for (const filter of filters) {
    const predicate = buildFieldFilterPredicate(
      filter,
      fieldTypes.get(filter.key),
      undefined,
      // A `formula` compares as whatever its expression evaluates to — without
      // the config it would fall back to comparing the column as text.
      definitions.find((d) => d.key === filter.key)?.config,
    );
    if (predicate) conditions.push(predicate);
  }

  // Metrics are aliased positionally (`m0`, `m1`, …) rather than by their
  // caller-supplied name: no quoting question, no collision with `group_value`.
  const selections: SQL[] = [];
  const groupings: SQL[] = [];

  // A dimension with no column behind it must be named here. Postgres would
  // raise `column "x" does not exist` wrapped in a DrizzleQueryError whose
  // message is the whole failed statement — the caller (and the agent reading
  // the dataset error) learns nothing about WHICH field is unusable, or why.
  for (const [label, key] of [
    ["group by", groupBy],
    ["series by", seriesBy],
  ] as const) {
    if (!key) continue;
    const type = fieldTypes.get(key);
    if (!type) {
      throw new Error(
        `cannot ${label} "${key}": this type has no enabled field with that key.`,
      );
    }
    if (VIRTUAL_FIELD_TYPES.has(type)) {
      throw new Error(
        `cannot ${label} "${key}": it is a ${type} field, computed at read time and not stored. Group by a stored field instead.`,
      );
    }
  }

  // `multi_select` dimensions expand through LATERAL unnest — one row per value.
  // A record then contributes once PER value, which is what a breakdown-by-tag
  // means for `count`; a `sum` over such a dimension counts its rows once per tag.
  const laterals = [
    groupBy ? lateralFor(groupBy, fieldTypes.get(groupBy)) : null,
    seriesBy ? lateralFor(seriesBy, fieldTypes.get(seriesBy)) : null,
  ].filter((join): join is SQL => join !== null);

  if (groupBy) {
    const expression = groupExpression(
      groupBy,
      fieldTypes.get(groupBy),
      dateBucket,
    );
    selections.push(sql`${expression} AS group_value`);
    groupings.push(expression);
  } else {
    selections.push(sql`NULL::text AS group_value`);
  }

  if (seriesBy) {
    const expression = groupExpression(seriesBy, fieldTypes.get(seriesBy));
    selections.push(sql`${expression} AS series_value`);
    groupings.push(expression);
  } else {
    selections.push(sql`NULL::text AS series_value`);
  }

  metrics.forEach((metric, index) => {
    selections.push(
      sql`${metricExpression(metric, fieldTypes)} AS ${sql.raw(`m${index}`)}`,
    );
  });

  const metricIndex = metrics.findIndex((metric) => metric.name === sortBy);
  const orderExpression =
    metricIndex >= 0
      ? sql.raw(`m${metricIndex}`)
      : sortBy === "series" && seriesBy
        ? sql`series_value`
        : groupBy
          ? sql`group_value`
          : undefined;
  const orderBy =
    orderExpression === undefined
      ? sql``
      : sql`ORDER BY ${orderExpression} ${sql.raw(sortDir === "asc" ? "ASC" : "DESC")} NULLS LAST`;

  const groupBySql =
    groupings.length > 0
      ? sql`GROUP BY ${sql.join(groupings, sql`, `)}`
      : sql``;

  const lateralSql = laterals.length > 0 ? sql.join(laterals, sql` `) : sql``;

  const result = await db.execute(sql`
    SELECT ${sql.join(selections, sql`, `)}
    FROM ${collectionRecords}
    JOIN ${table} e ON e."id" = ${collectionRecords.id}
    ${lateralSql}
    WHERE ${and(...conditions)}
    ${groupBySql}
    ${orderBy}
    LIMIT ${limit + 1}
  `);

  const truncated = result.rows.length > limit;
  const rows = (truncated ? result.rows.slice(0, limit) : result.rows).map(
    (row) => {
      const mapped: AggregateRow = {
        group: typeof row.group_value === "string" ? row.group_value : null,
      };
      if (seriesBy) {
        mapped.series =
          typeof row.series_value === "string" ? row.series_value : null;
      }
      metrics.forEach((metric, index) => {
        const raw = row[`m${index}`];
        mapped[metric.name] = raw == null ? null : Number(raw);
      });
      return mapped;
    },
  );

  return { rows, truncated };
};
