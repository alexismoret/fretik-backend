import type {
  PageDataResponse,
  PageDataset,
  PageDatasetQuery,
  PageDatasetResult,
  PageDefinition,
  PageValue,
  PageVariable,
} from "../../schemas/pages";
import { PAGE_LIMITS } from "../../schemas/pages";
import { pageDataSource } from "./sources/registry";

/**
 * Execute a page's datasets and return their rows.
 *
 * THE SECURITY BOUNDARY LIVES HERE. A viewer's browser may send exactly one
 * thing: values for the variables the page DECLARES. Every collection, filter
 * key and operator comes from the stored definition, so no caller — authed or
 * anonymous — can widen a page's reach beyond what its author froze into it.
 * Unknown variable keys are dropped rather than honoured.
 *
 * What this file owns is what is true of EVERY source: the boundary above,
 * dependency ordering, per-dataset degradation (`forbidden` / `error` instead
 * of failing the request — one unreadable collection must cost its own block,
 * not the page), and targeted refetch. Where rows come from is a resolver in
 * `sources/`, looked up by kind.
 */

/** Coerce an incoming variable value to its declared type, or drop it. */
const coerceVariable = (
  variable: PageVariable,
  value: PageValue,
): PageValue | undefined => {
  switch (variable.type) {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "number":
      return typeof value === "number" ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "string_list":
      return Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
    case "date_range":
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "start" in value &&
        "end" in value
        ? value
        : undefined;
    case "json":
      return value;
  }
};

/**
 * Merge declared initials with the viewer's submitted values. Anything the
 * page does not declare never reaches a query.
 */
export const resolvePageState = (
  definition: PageDefinition,
  submitted: Record<string, PageValue>,
): Record<string, PageValue> => {
  const state: Record<string, PageValue> = {};
  for (const variable of definition.variables) {
    const incoming = submitted[variable.key];
    const coerced =
      incoming === undefined ? undefined : coerceVariable(variable, incoming);
    state[variable.key] = coerced ?? variable.initial ?? null;
  }
  return state;
};

/**
 * Keep one dataset's answer under the byte ceiling by dropping rows from the
 * end, and say so.
 *
 * Every other bound in `PAGE_LIMITS` counts rows, and a row has no size: a
 * `records` dataset over a type with a long markdown field, or an external
 * answer nobody bounded, can serialize to tens of megabytes inside a perfectly
 * legal row count. The retired `transform` sandbox capped its own output at
 * 1 MB and was the only thing in the path that measured bytes at all.
 *
 * Truncating rather than failing is the whole design: `truncated` is a flag the
 * result already carries and every page already renders, so a page that runs
 * into this shows fewer rows instead of an error block. Halving is used rather
 * than a per-row scan because the cost has to stay proportional to the OVERSIZE
 * case, not to the ordinary one — an answer under the ceiling is serialized
 * once and touched no further.
 */
export const capDatasetBytes = (
  result: PageDatasetResult,
): PageDatasetResult => {
  if (result.status !== "ok" || result.rows.length === 0) return result;
  if (JSON.stringify(result.rows).length <= PAGE_LIMITS.maxDatasetResponseBytes)
    return result;
  let rows = result.rows;
  while (
    rows.length > 1 &&
    JSON.stringify(rows).length > PAGE_LIMITS.maxDatasetResponseBytes
  ) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
  }
  return { ...result, rows, truncated: true };
};

/** A dataset slower than this is worth a line in the logs, not a failure. */
const SLOW_DATASET_MS = 1000;

/**
 * How long ONE run may spend waiting on third parties, every external dataset
 * counted together.
 *
 * A single call waits up to 45 s (`exec/page-query.ts`), and datasets over an
 * app that leases a licence seat run one after another — so five slow widgets
 * would hold a render for minutes without a ceiling over the whole run. 90 s
 * buys two full waits, which is what a cold page over a genuinely slow app
 * needs to warm its cache; the datasets past the budget are not asked at all
 * and come back on the next render against the answers that landed meanwhile.
 */
const EXTERNAL_RUN_BUDGET_MS = 90_000;

/** Postgres `undefined_column` — the dataset named a field the type has not. */
const UNDEFINED_COLUMN = "42703";
const MAX_ERROR_CHARS = 300;

/**
 * What a failed dataset tells the agent.
 *
 * The driver's own message is `Failed query: <the entire SQL>`, and that is
 * what used to travel: a wall of generated SQL naming the physical table
 * `data.coll_<uuid>`, with the actual cause — one wrong column — buried in it.
 * Observed on a real run (2026-08-17): the agent read three of those, could not
 * tell which layer had failed, concluded "the transform keeps failing in the
 * sandbox" (it was an aggregate, and the sandbox was never involved), and
 * rewrote the page to bucket its rows in the component instead.
 *
 * The inner driver error carries the useful half — a SQLSTATE and one sentence.
 * That is what goes back, plus the one instruction that fixes the common case.
 *
 * RULE: an error crossing into an agent's context is a prompt. A hundred lines
 * of SQL is not a diagnosis, and it costs tokens to be misled by.
 */
export const describeDatasetError = (cause: unknown): string => {
  const inner =
    cause instanceof Error && cause.cause instanceof Error
      ? cause.cause
      : cause;
  const code =
    inner !== null && typeof inner === "object"
      ? Reflect.get(inner, "code")
      : undefined;
  // Deliberately NOT `String(inner)`: on an object that yields the
  // `[object Object]` this whole helper exists to keep out of the agent's
  // context.
  const message =
    inner instanceof Error
      ? inner.message
      : typeof inner === "string"
        ? inner
        : "unknown error";

  if (code === UNDEFINED_COLUMN) {
    return `${message}. A dataset names a field this collection does not have — \`dry_run\` the definition with no code to see the real field keys.`;
  }
  return message.slice(0, MAX_ERROR_CHARS);
};

export const runPageData = async (params: {
  definition: PageDefinition;
  /** Team whose scope the queries run under (viewer's, or the owner's for a
   * published page). */
  teamId: string;
  /** The viewer, when the route knows one; null on the anonymous public
   * route. External datasets resolve "their own connection" from it. */
  userId: string | null;
  /**
   * The page being viewed. Carried for ONE purpose: a source that resolves a
   * per-viewer choice (which connected account this page reads through) needs
   * to know which page the choice is about. Absent on a dry run and on the
   * anonymous route, where there is no choice to honour.
   */
  pageId?: string;
  variables: Record<string, PageValue>;
  /** Restrict execution to these dataset ids (a targeted refetch). */
  datasetIds?: string[];
  /** Per-dataset window and ordering, keyed by dataset id. */
  queries?: Record<string, PageDatasetQuery>;
  /** Refresh button: sources that cache upstream answers bypass their read. */
  fresh?: boolean;
  /**
   * How long this run may spend waiting on third parties, all datasets
   * together. Defaults to `EXTERNAL_RUN_BUDGET_MS`; a caller with its own
   * ceiling (a render harness, a job) passes a smaller one.
   */
  externalBudgetMs?: number;
}): Promise<PageDataResponse> => {
  const state = resolvePageState(params.definition, params.variables);
  const deadlineAt =
    Date.now() + (params.externalBudgetMs ?? EXTERNAL_RUN_BUDGET_MS);

  const wanted = params.datasetIds ? new Set(params.datasetIds) : null;
  const results: Record<string, PageDatasetResult> = {};

  // Only what was asked for. Datasets are INDEPENDENT since `transform` was
  // retired — nothing reads another's rows — so a targeted refetch runs
  // exactly its own set, with no closure to walk and nothing else to drag in.
  const toRun = params.definition.datasets.filter(
    (dataset) => !wanted || wanted.has(dataset.id),
  );

  const runOne = async (dataset: PageDataset): Promise<PageDatasetResult> => {
    const id = dataset.id;
    const source = pageDataSource(dataset.kind);
    if (!source) {
      return {
        status: "error",
        message: `no source is registered for dataset kind "${dataset.kind}"`,
      };
    }
    const startedAt = performance.now();
    try {
      return await source.resolve(dataset, {
        teamId: params.teamId,
        userId: params.userId,
        ...(params.pageId !== undefined ? { pageId: params.pageId } : {}),
        state,
        ...(params.queries?.[id] !== undefined
          ? { query: params.queries[id] }
          : {}),
        ...(params.fresh !== undefined ? { fresh: params.fresh } : {}),
        deadlineAt,
      });
    } catch (cause) {
      return { status: "error", message: describeDatasetError(cause) };
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed > SLOW_DATASET_MS) {
        console.warn(
          `[page-data] dataset "${id}" (${dataset.kind}) took ${Math.round(elapsed).toString()}ms`,
        );
      }
    }
  };

  // Everything at once. A dashboard's widgets are independent by construction,
  // so running them in series made a page's latency the SUM of its queries;
  // flat it is the slowest one. This is also what keeps a single slow source
  // from freezing a whole page now that a dataset can reach a third party.
  //
  // This was a dependency-WAVE loop until 2026-08-21, with a readiness test and
  // a cycle report — machinery that existed for `transform`, the only source
  // that ever read another dataset. Nothing left has inputs, so there is
  // nothing to order and no cycle to detect.
  //
  // The ONE exception is not a dependency, it is a third party's tolerance: a
  // source may declare that two of its datasets cannot be in flight together
  // (`PageDataSource.serialKey` — an app that leases a licence seat per call).
  // Those queue behind each other inside their own group; every group, and
  // everything ungrouped, still runs together. Without this the datasets would
  // still be CORRECT — `withConnectionSlot` serialises them anyway — but they
  // would spend the render fighting over a lock they could simply have taken
  // in turn.
  //
  // `runOne` never rejects: a source that throws degrades to its own error
  // block, so one broken dataset costs its widget and not the page.
  const groups = new Map<string, PageDataset[]>();
  const independent: PageDataset[] = [];
  for (const dataset of toRun) {
    const key = pageDataSource(dataset.kind)?.serialKey?.(dataset);
    if (key === undefined) {
      independent.push(dataset);
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), dataset]);
  }

  const runGroup = async (
    datasets: PageDataset[],
  ): Promise<(readonly [string, PageDatasetResult])[]> => {
    const settled: (readonly [string, PageDatasetResult])[] = [];
    for (const dataset of datasets) {
      // eslint-disable-next-line no-await-in-loop -- the point: one at a time
      settled.push([dataset.id, await runOne(dataset)] as const);
    }
    return settled;
  };

  const settled = (
    await Promise.all([
      ...independent.map(async (dataset) => [
        [dataset.id, await runOne(dataset)] as const,
      ]),
      ...[...groups.values()].map(runGroup),
    ])
  ).flat();
  for (const [id, result] of settled) results[id] = capDatasetBytes(result);

  return { datasets: results };
};
