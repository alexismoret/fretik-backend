import db from "../../../db";
import type { RecordFilter } from "../../../schemas/ontology";
import type {
  PageDataset,
  PageDatasetQuery,
  PageDatasetResult,
  PageFieldDescriptor,
  PageMetric,
  PageValue,
} from "../../../schemas/pages";
import { PAGE_LIMITS, isPageVarRef } from "../../../schemas/pages";
import { aggregateRecords } from "../../collection-records/aggregate";
import { listCollectionRecords } from "../../collection-records/retrieve";
import { buildPageFieldDescriptors } from "../field-descriptors";
import type { PageDataSource } from "./types";
import { toPageValue } from "./values";

/**
 * A live query over the workspace's own records — the source that makes a page
 * a dashboard rather than a snapshot.
 */

/**
 * Resolve a dataset's filters against page state. A filter whose value is a
 * `{ var }` reference substitutes that variable's current value; one that
 * resolves to nothing is DROPPED, which is what makes an "All" option work
 * without a special case.
 */
const resolveFilters = (
  dataset: PageDataset,
  state: Record<string, PageValue>,
): RecordFilter[] => {
  const resolved: RecordFilter[] = [];
  for (const filter of dataset.filters ?? []) {
    // Value-less operators (`is_empty`, `is_true`, …) carry no value at all.
    if (filter.value === undefined) {
      resolved.push({ key: filter.key, op: filter.op });
      continue;
    }
    if (!isPageVarRef(filter.value)) {
      resolved.push({ key: filter.key, op: filter.op, value: filter.value });
      continue;
    }
    const value = state[filter.value.var];
    if (value === undefined || value === null || value === "") continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      resolved.push({ key: filter.key, op: filter.op, value });
      continue;
    }
    if (Array.isArray(value) && value.every((e) => typeof e === "string")) {
      if (value.length > 0) {
        resolved.push({ key: filter.key, op: filter.op, value });
      }
      continue;
    }
    if (typeof value === "object" && "start" in value && "end" in value) {
      const start = Reflect.get(value, "start");
      const end = Reflect.get(value, "end");
      resolved.push({
        key: filter.key,
        op: filter.op,
        value: {
          start: typeof start === "string" ? start : null,
          end: typeof end === "string" ? end : null,
        },
      });
    }
  }
  return resolved;
};

/**
 * Sort keys that live on the record registry itself rather than on a field.
 *
 * They were unreachable before: every sort key was prefixed with `field:`, so
 * asking for `label` looked for a FIELD called label, found none, and silently
 * fell back to `createdAt` — the most requested ordering of all was the one
 * that could not be expressed.
 */
const STRUCTURAL_SORT_KEYS: ReadonlySet<string> = new Set([
  "label",
  "createdAt",
  "updatedAt",
]);

/**
 * Turn a sort NAME into the key the record service understands, or nothing.
 *
 * Resolving against the real descriptors is what makes a runtime sort safe to
 * accept from a browser: an unknown name is dropped here, so it can never reach
 * the query as an identifier. It also has to be dropped rather than passed
 * through — a `field:<unknown>` would compose SQL over a column that does not
 * exist and fail the whole dataset, where the honest answer is the default
 * order.
 */
const resolveSortKey = (
  sortBy: string | undefined,
  fields: PageFieldDescriptor[],
): string | undefined => {
  if (!sortBy) return undefined;
  if (STRUCTURAL_SORT_KEYS.has(sortBy)) return sortBy;
  const field = fields.find((candidate) => candidate.key === sortBy);
  if (!field || field.sortable === false) return undefined;
  return `field:${sortBy}`;
};

/**
 * The same question for an AGGREGATE, whose sort names are not field keys.
 *
 * An aggregate's columns are `group`, `series` and the metric names the dataset
 * declared, so `resolveSortKey` — which validates against the type's fields —
 * would reject every one of them. Without this the aggregate branch ignored
 * `query` entirely: a chart could not be re-sorted and a "top 10" could not
 * become a "top 20" without the author having foreseen it, which is the one
 * thing a large page is made of.
 *
 * Unknown names are DROPPED rather than passed through, exactly as above: the
 * name reaches an ORDER BY, and the honest answer to a stale one is the
 * author's own order.
 */
const resolveAggregateSortKey = (
  sortBy: string | undefined,
  metrics: PageMetric[],
): string | undefined => {
  if (!sortBy) return undefined;
  if (sortBy === "group" || sortBy === "series") return sortBy;
  return metrics.some((metric) => metric.name === sortBy) ? sortBy : undefined;
};

/**
 * The window of rows to read: what the viewer asked for, bounded by what the
 * page allows.
 *
 * The definition's `limit` is the page size the author chose; a runtime
 * `pageSize` overrides it for a table the viewer is walking. The offset ceiling
 * is re-applied here and not just in the schema, because `page × pageSize` is
 * what Postgres skips row by row — the two bounds multiply, and only their
 * product matters.
 */
const resolveWindow = (
  dataset: PageDataset,
  query: PageDatasetQuery | undefined,
): { limit: number; page: number } => {
  const limit = Math.min(
    query?.pageSize ?? dataset.limit ?? 100,
    PAGE_LIMITS.maxRows,
  );
  const requested = Math.max(1, query?.page ?? 1) - 1;
  const maxPage = Math.floor(PAGE_LIMITS.maxOffset / limit);
  return { limit, page: Math.min(requested, maxPage) };
};

/** Flatten a record row to what a page binds against: `{ id, label, …data }`. */
const flattenRecordRow = (row: {
  id: string;
  label: string | null;
  data: Record<string, unknown>;
  computed?: Record<string, unknown>;
}): PageValue => {
  const flat: Record<string, PageValue> = {};
  for (const [key, value] of Object.entries({
    ...row.data,
    ...(row.computed ?? {}),
  })) {
    flat[key] = toPageValue(value);
  }
  flat.id = row.id;
  flat.label = row.label;
  return flat;
};

export const collectionsSource: PageDataSource = {
  kind: "collections",
  resolve: async (
    dataset,
    { teamId, state, query },
  ): Promise<PageDatasetResult> => {
    if (!dataset.collectionId) {
      return { status: "error", message: "dataset has no collectionId" };
    }

    const type = await db.query.collections.findFirst({
      columns: { id: true },
      where: { id: dataset.collectionId },
    });
    if (!type) return { status: "forbidden" };

    const filters = resolveFilters(dataset, state);
    // Read the descriptors BEFORE the rows: they are what a runtime sort key is
    // validated against, and they come from the field-definition cache, so this
    // is a map lookup rather than a second round trip.
    const fields = await buildPageFieldDescriptors({
      teamId,
      collectionId: dataset.collectionId,
    });

    if (dataset.mode === "aggregate") {
      const metrics = dataset.metrics ?? [{ name: "count", fn: "count" }];
      // An aggregate honours `query` too. It used to ignore it, which made
      // every chart on a page permanently sorted and sized the way its author
      // guessed — no clickable legend, no "top 20 instead of top 10".
      const sortBy =
        resolveAggregateSortKey(query?.sortBy, metrics) ??
        resolveAggregateSortKey(dataset.sortBy, metrics);
      const { rows, truncated } = await aggregateRecords({
        teamId,
        collectionId: dataset.collectionId,
        filters,
        groupBy: dataset.groupBy,
        dateBucket: dataset.dateBucket,
        seriesBy: dataset.seriesBy,
        metrics,
        // `pageSize` is how many GROUPS to return here — an aggregate has no
        // offset to page through, so `page` means nothing and is ignored.
        limit: Math.min(
          query?.pageSize ?? dataset.limit ?? PAGE_LIMITS.maxRows,
          PAGE_LIMITS.maxRows,
        ),
        ...(sortBy !== undefined ? { sortBy } : {}),
        sortDir: query?.sortDir ?? dataset.sortDir,
      });
      // An aggregate's columns are metrics, not fields — but the grouping
      // dimension IS a field, and shipping its descriptor is what lets a chart
      // axis or a table column show a status by its own colour and label.
      return { status: "ok", rows, truncated, fields };
    }

    const { limit, page } = resolveWindow(dataset, query);
    // A runtime sort wins over the author's default — that is the whole point
    // of a clickable header — but both go through the same resolution, so a
    // stale definition cannot compose SQL over a field that no longer exists.
    const sortBy = resolveSortKey(query?.sortBy ?? dataset.sortBy, fields);
    const sortDir = query?.sortDir ?? dataset.sortDir;
    const { count, data } = await listCollectionRecords({
      teamId,
      collectionId: dataset.collectionId,
      filters,
      limit,
      page,
      ...(sortBy !== undefined ? { sortBy } : {}),
      ...(sortDir !== undefined ? { sortDir } : {}),
    });
    return {
      status: "ok",
      rows: data.map(flattenRecordRow),
      truncated: count > data.length,
      // The list query already pays for this COUNT — dropping it forced every
      // table to paginate over "what happened to be loaded" and to sum columns
      // that were only ever a slice.
      totalCount: count,
      // Echo the window the server ACTUALLY read, not the one asked for: both
      // may have been clamped, and a paginator drawn from the request would
      // point at a page the viewer is not on.
      page: page + 1,
      pageSize: limit,
      ...(sortBy !== undefined
        ? { sortBy: sortBy.replace(/^field:/, ""), sortDir: sortDir ?? "desc" }
        : {}),
      fields,
    };
  },
};
