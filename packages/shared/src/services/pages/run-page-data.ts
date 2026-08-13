import type {
  PageDataResponse,
  PageDataset,
  PageDatasetQuery,
  PageDatasetResult,
  PageDefinition,
  PageValue,
  PageVariable,
} from "../../schemas/pages";
import { pageDataSource } from "./sources/registry";

/**
 * Execute a page's datasets and return their rows.
 *
 * THE SECURITY BOUNDARY LIVES HERE. A viewer's browser may send exactly one
 * thing: values for the variables the page DECLARES. Every object type, filter
 * key and operator comes from the stored definition, so no caller — authed or
 * anonymous — can widen a page's reach beyond what its author froze into it.
 * Unknown variable keys are dropped rather than honoured.
 *
 * What this file owns is what is true of EVERY source: the boundary above,
 * dependency ordering, per-dataset degradation (`forbidden` / `error` instead
 * of failing the request — one unreadable object type must cost its own block,
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
 * The datasets a targeted refetch has to run: the ones asked for, plus
 * everything they read, transitively.
 *
 * Without this, asking for one dataset executed ALL of them and threw away the
 * rest of the output — so re-sorting one table re-ran every query on the page.
 * The closure is the other half: a transform is worthless without its inputs,
 * so they come along, but nothing else does.
 */
const executionClosure = (
  datasets: PageDataset[],
  wanted: Set<string>,
): Set<string> => {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const keep = new Set<string>();
  const stack = [...wanted];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || keep.has(id)) continue;
    const dataset = byId.get(id);
    if (!dataset) continue;
    keep.add(id);
    const inputs = pageDataSource(dataset.kind)?.dependsOn?.(dataset) ?? [];
    stack.push(...inputs);
  }
  return keep;
};

/** A dataset slower than this is worth a line in the logs, not a failure. */
const SLOW_DATASET_MS = 1000;

export const runPageData = async (params: {
  definition: PageDefinition;
  /** Team whose scope the queries run under (viewer's, or the owner's for a
   * published page). */
  teamId: string;
  /** The viewer, when the route knows one; null on the anonymous public
   * route. External datasets resolve "their own connection" from it. */
  userId: string | null;
  variables: Record<string, PageValue>;
  /** Restrict execution to these dataset ids (a targeted refetch). */
  datasetIds?: string[];
  /** Per-dataset window and ordering, keyed by dataset id. */
  queries?: Record<string, PageDatasetQuery>;
  /** Refresh button: sources that cache upstream answers bypass their read. */
  fresh?: boolean;
}): Promise<PageDataResponse> => {
  const state = resolvePageState(params.definition, params.variables);

  const wanted = params.datasetIds ? new Set(params.datasetIds) : null;
  const results: Record<string, PageDatasetResult> = {};
  const rowsById: Record<string, PageValue> = {};

  // A source may read other datasets, so run in dependency order. A pass that
  // resolves nothing means the rest is cyclic or dangling — report it rather
  // than looping.
  const runnable = wanted
    ? executionClosure(params.definition.datasets, wanted)
    : null;
  const pending = new Map<string, PageDataset>(
    params.definition.datasets
      .filter((dataset) => !runnable || runnable.has(dataset.id))
      .map((dataset) => [dataset.id, dataset]),
  );

  const runOne = async (
    id: string,
    dataset: PageDataset,
  ): Promise<PageDatasetResult> => {
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
        state,
        data: rowsById,
        ...(params.queries?.[id] !== undefined
          ? { query: params.queries[id] }
          : {}),
        ...(params.fresh !== undefined ? { fresh: params.fresh } : {}),
      });
    } catch (cause) {
      return {
        status: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed > SLOW_DATASET_MS) {
        console.warn(
          `[page-data] dataset "${id}" (${dataset.kind}) took ${Math.round(elapsed).toString()}ms`,
        );
      }
    }
  };

  while (pending.size > 0) {
    // Everything whose inputs are settled runs TOGETHER. A dashboard's widgets
    // are independent by construction, so running them in series made its
    // latency the SUM of its queries; in parallel it is the slowest one. This
    // is also what keeps a single slow source from freezing the whole page once
    // datasets can reach a third party.
    const ready: [string, PageDataset][] = [];
    for (const [id, dataset] of pending) {
      const inputs = pageDataSource(dataset.kind)?.dependsOn?.(dataset) ?? [];
      const isReady = inputs.every(
        (input) => input in rowsById || !pending.has(input),
      );
      if (isReady) ready.push([id, dataset]);
    }

    if (ready.length === 0) {
      // Naming the stuck set is the whole fix here: "inputs are missing or form
      // a cycle" told the agent neither WHICH dataset nor WHICH input, so the
      // only way forward was to re-read the definition and guess.
      //
      // Only a genuine cycle reaches this branch. An input NO dataset declares
      // passes the readiness test above and resolves to null — `sanitize`
      // reports that one, at write time, by name.
      const stuck = [...pending.keys()].map((id) => `"${id}"`).join(", ");
      for (const [id, dataset] of pending) {
        const inputs = pageDataSource(dataset.kind)?.dependsOn?.(dataset) ?? [];
        const waiting = inputs
          .filter((input) => !(input in rowsById))
          .map((input) => `"${input}"`)
          .join(", ");
        results[id] = {
          status: "error",
          message: `dataset "${id}" waits on ${waiting}, which waits back: ${stuck} form a cycle. Break it by inlining one side, or by reading the shared source twice.`,
        };
      }
      break;
    }

    for (const [id] of ready) pending.delete(id);
    // `runOne` never rejects — a source that throws degrades to its own error
    // block, so one broken dataset costs its widget and not the page.
    const settled = await Promise.all(
      ready.map(
        async ([id, dataset]) => [id, await runOne(id, dataset)] as const,
      ),
    );
    for (const [id, result] of settled) {
      if (result.status === "ok") rowsById[id] = result.rows;
      // A dataset pulled in by the closure is still executed — a transform
      // needs its inputs — but only what was ASKED for is returned.
      if (!wanted || wanted.has(id)) results[id] = result;
    }
  }

  return { datasets: results };
};
