import { evaluatePageExpression } from "@fretik/render/runtime/expressions";
import type {
  PageDefinition,
  PageElement,
  PageSpec,
  PageValue,
} from "../../schemas/pages";
import { eachPageBinding } from "../../schemas/pages";
import { resolvePageState, runPageData } from "./run-page-data";
import {
  pushPagePolish,
  pushPageWarning,
  sanitizePageDefinition,
} from "./sanitize";

/**
 * Dry-run a page against REAL data before it is handed to anyone.
 *
 * This is the feature's answer to "more freedom means more ways to get it
 * wrong": rather than constraining the model into a shape it cannot misuse, we
 * execute what it wrote — run every dataset, evaluate every binding against
 * the rows that came back — and hand the failures BACK TO THE AGENT as
 * warnings. The mistake gets caught in the turn that made it, not by the user
 * opening a broken page.
 *
 * It doubles as the agent's free PROBE. `samples` reports row counts, the
 * distinct values of a grouping column and one real row per dataset — which is
 * every question the agent used to answer by writing exploratory SQL.
 */

export interface PageDatasetSample {
  status: string;
  rowCount: number;
  /** One real row, long values clipped. Shows the actual field names. */
  sample?: PageValue;
  /** Grouped datasets: how many distinct groups, and which. */
  groupCount?: number;
  groupValues?: string[];
  /** Field key → type, for the fields this dataset carries. */
  fields?: Record<string, string>;
}

export interface PageDryRun {
  warnings: string[];
  /** Works, but reads as unfinished. */
  polish: string[];
  samples: Record<string, PageDatasetSample>;
}

interface Binding {
  where: string;
  expression: string;
  /**
   * True when the expression can only resolve against a row that exists at
   * render time — inside a `repeat`, in a table cell, or in a row event
   * handler. Such a binding is evaluated against a SAMPLE row rather than
   * skipped: skipping it left every conditional style in the page unverified,
   * which is exactly where the interesting mistakes are.
   */
  rowScoped: boolean;
  /** Dataset whose sample row stands in for `item`. */
  rowDataset?: string;
}

const datasetPropOf = (element: PageElement): string | undefined => {
  const value = element.props?.["dataset"];
  return typeof value === "string" ? value : undefined;
};

/** `/data/sales` → `sales`; anything else is not a dataset. */
const datasetOfStatePath = (statePath: string): string | undefined => {
  const [head, id] = statePath.replace(/^\//, "").split("/");
  return head === "data" ? id : undefined;
};

/**
 * Every expression in the spec, with a human-readable location.
 *
 * Walks from the root rather than iterating the map: whether a binding is ROW
 * SCOPED depends entirely on what sits above it — a `repeat` ancestor, a table
 * cell, a row event — and that is only knowable along a path.
 */
const collectBindings = (spec: PageSpec, found: Binding[]): void => {
  const visit = (
    key: string,
    ancestors: Set<string>,
    inRow: boolean,
    rowDataset: string | undefined,
  ): void => {
    const element = spec.elements[key];
    if (!element || ancestors.has(key)) return;

    const push = (
      where: string,
      value: PageValue,
      scoped: boolean,
      dataset?: string,
    ) => {
      eachPageBinding(value, (expression) => {
        found.push({
          where,
          expression,
          rowScoped: scoped,
          rowDataset: dataset,
        });
      });
    };

    if (element.visible !== undefined) {
      push(`element "${key}" visible`, element.visible, inRow, rowDataset);
    }
    for (const [name, value] of Object.entries(element.props ?? {})) {
      push(`element "${key}" prop "${name}"`, value, inRow, rowDataset);
    }
    for (const [event, binding] of Object.entries(element.on ?? {})) {
      // A row event hands the clicked row in as `item`, which exists only at
      // render time — so its params are checked against a sample row.
      const eventInRow = inRow || event === "row_click";
      const eventDataset =
        event === "row_click"
          ? (datasetPropOf(element) ?? rowDataset)
          : rowDataset;
      for (const action of Array.isArray(binding) ? binding : [binding]) {
        for (const [name, value] of Object.entries(action.params ?? {})) {
          push(
            `element "${key}" on ${event} param "${name}"`,
            value,
            eventInRow,
            eventDataset,
          );
        }
      }
    }
    for (const [path, binding] of Object.entries(element.watch ?? {})) {
      for (const action of Array.isArray(binding) ? binding : [binding]) {
        for (const [name, value] of Object.entries(action.params ?? {})) {
          push(
            `element "${key}" watch ${path} param "${name}"`,
            value,
            inRow,
            rowDataset,
          );
        }
      }
    }

    // Children inherit the row scope this element opens: its own `repeat`, or —
    // for a table cell — the row of the table above it.
    const repeatDataset = element.repeat
      ? datasetOfStatePath(element.repeat.statePath)
      : undefined;
    const childInRow = inRow || element.repeat !== undefined;
    const childDataset = repeatDataset ?? rowDataset;

    const next = new Set(ancestors);
    next.add(key);
    for (const child of element.children ?? []) {
      const cell = spec.elements[child]?.type === "table_cell";
      visit(
        child,
        next,
        childInRow || cell,
        cell ? (datasetPropOf(element) ?? childDataset) : childDataset,
      );
    }
  };

  visit(spec.root, new Set(), false, undefined);
};

/** Clip long strings so a markdown blob does not travel on every write. */
const clip = (value: PageValue, depth = 0): PageValue => {
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  if (depth > 2) return null;
  if (Array.isArray(value))
    return value.slice(0, 3).map((v) => clip(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, PageValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = clip(inner, depth + 1);
    }
    return out;
  }
  return value;
};

const asRecord = (value: PageValue): Record<string, PageValue> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const numbersOf = (rows: PageValue[], key: string): number[] => {
  const values: number[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) values.push(value);
  }
  return values;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Checks that need REAL data to fire — the ones a static pass cannot make.
 * Each names the fix, never just the fault.
 */
const collectDataChecks = (
  definition: PageDefinition,
  data: Record<string, PageValue>,
  warnings: string[],
  polish: string[],
): void => {
  const datasetById = new Map(definition.datasets.map((d) => [d.id, d]));

  for (const [key, element] of Object.entries(definition.spec.elements)) {
    const datasetId = datasetPropOf(element);
    const rows =
      datasetId !== undefined && Array.isArray(data[datasetId])
        ? data[datasetId]
        : [];
    const dataset =
      datasetId !== undefined ? datasetById.get(datasetId) : undefined;

    if (element.type.startsWith("chart_") && rows.length > 0) {
      if (rows.length <= 2 && !dataset?.seriesBy) {
        pushPagePolish(
          polish,
          `element "${key}": ${rows.length.toString()} categor${rows.length === 1 ? "y" : "ies"} is not a chart — a \`stat\` (or two side by side) reads faster and takes a quarter of the space.`,
        );
      }
      if (element.type === "chart_donut" && rows.length > 6) {
        pushPageWarning(
          warnings,
          `element "${key}": ${rows.length.toString()} slices in a donut. Past six the eye cannot compare arcs — use chart_bar with horizontal: true, or fold the tail into "Other".`,
        );
      }
      // Two metrics of wildly different magnitude on one axis is the single
      // most common chart mistake. There is deliberately NO second axis, so
      // name the two legal ways out instead.
      const metrics = dataset?.metrics ?? [];
      if (metrics.length >= 2) {
        const scales = metrics
          .map((metric) => {
            const values = numbersOf(rows, metric.name).map(Math.abs);
            const max = values.length > 0 ? Math.max(...values) : 0;
            return { name: metric.name, max };
          })
          .filter((entry) => entry.max > 0);
        if (scales.length >= 2) {
          const biggest = scales.reduce((a, b) => (a.max > b.max ? a : b));
          const smallest = scales.reduce((a, b) => (a.max < b.max ? a : b));
          if (biggest.max > smallest.max * 100) {
            pushPageWarning(
              warnings,
              `element "${key}": "${biggest.name}" is over 100× "${smallest.name}", so the smaller series will be a flat line on the axis. There is no second y-axis by design — either split them into two charts, or index both to a common base in a transform.`,
            );
          }
        }
      }
      // A ratio plotted as a raw number reads "0.42" where "42%" was meant.
      const format = element.props?.["format"];
      for (const metric of metrics) {
        const values = numbersOf(rows, metric.name);
        if (
          values.length > 0 &&
          values.every((v) => v >= 0 && v <= 1) &&
          values.some((v) => v > 0) &&
          format !== "percent"
        ) {
          pushPagePolish(
            polish,
            `element "${key}": every value of "${metric.name}" sits between 0 and 1 — set format: "percent" so it reads as a share rather than a decimal.`,
          );
        }
      }
    }

    if (
      element.type === "chart_bar" &&
      rows.length > 0 &&
      !element.props?.["horizontal"]
    ) {
      const xProp = element.props?.["x"];
      const first = asRecord(rows[0] ?? null)?.[
        typeof xProp === "string" ? xProp : "group"
      ];
      if (typeof first === "string" && ISO_DATE_RE.test(first)) {
        pushPagePolish(
          polish,
          `element "${key}": its categories are dates — a chart_line (or chart_area) shows a trend over time; bars ask the reader to compare unrelated columns.`,
        );
      }
    }
  }
};

export const dryRunPage = async (params: {
  definition: PageDefinition;
  teamId: string;
  /**
   * The caller already ran `sanitizePageDefinition` and is passing the result.
   * `create`/`update` do: they hand over the STORED definition, which is the
   * sanitized one. Without this the same definition was sanitized twice per
   * write and every structural finding arrived in duplicate.
   */
  assumeSanitized?: boolean;
}): Promise<PageDryRun> => {
  const sanitized = params.assumeSanitized
    ? { definition: params.definition, warnings: [], polish: [] }
    : sanitizePageDefinition(params.definition);
  const { definition, warnings, polish } = sanitized;

  // Run against the page's own defaults — the state a first visitor sees.
  const state = resolvePageState(definition, {});
  const data: Record<string, PageValue> = {};
  const samples: PageDryRun["samples"] = {};

  const { datasets } = await runPageData({
    definition,
    teamId: params.teamId,
    variables: {},
  });

  const datasetById = new Map(definition.datasets.map((d) => [d.id, d]));

  for (const [id, result] of Object.entries(datasets)) {
    if (result.status === "ok") {
      data[id] = result.rows;
      const declared = datasetById.get(id);
      const sample: PageDatasetSample = {
        status: "ok",
        rowCount: result.rows.length,
        sample: result.rows[0] === undefined ? undefined : clip(result.rows[0]),
      };

      // The grouping dimension's real values — the answer to "how many
      // statuses are there, and what are they called" that the agent used to
      // buy with a SQL round trip.
      if (declared?.groupBy || declared?.mode === "aggregate") {
        const groups = new Set<string>();
        for (const row of result.rows) {
          const value = asRecord(row)?.group;
          if (typeof value === "string") groups.add(value);
        }
        if (groups.size > 0) {
          sample.groupCount = groups.size;
          sample.groupValues = [...groups].slice(0, 12);
        }
      }

      if (result.fields && result.fields.length > 0) {
        sample.fields = Object.fromEntries(
          result.fields.map((field) => [field.key, field.type]),
        );
      }

      samples[id] = sample;
      if (result.rows.length === 0) {
        pushPageWarning(
          warnings,
          `dataset "${id}" returned no rows — check its filters, or the object type may be empty.`,
        );
      }
    } else {
      data[id] = [];
      samples[id] = { status: result.status, rowCount: 0 };
      pushPageWarning(
        warnings,
        result.status === "forbidden"
          ? `dataset "${id}": this team cannot read that object type.`
          : `dataset "${id}" failed: ${result.message}`,
      );
    }
  }

  // Evaluate every binding against what actually came back. A binding that
  // yields nothing is usually a wrong field name, which is worth saying out
  // loud — the sample row above shows the real ones.
  const bindings: Binding[] = [];
  collectBindings(definition.spec, bindings);

  const emptyBindings: string[] = [];
  for (const binding of bindings) {
    // A row-scoped binding gets a REAL row to run against, so conditional
    // styling per row is verified rather than waved through.
    const rows = binding.rowDataset ? data[binding.rowDataset] : undefined;
    const item = Array.isArray(rows) ? (rows[0] ?? null) : null;
    const evaluated = await evaluatePageExpression(binding.expression, {
      state,
      data,
      ...(binding.rowScoped ? { item } : {}),
    });
    if (!evaluated.ok) {
      pushPageWarning(warnings, `${binding.where}: ${evaluated.error}`);
      continue;
    }
    // Only claim "resolved to nothing" when we actually had a row to try.
    const hadRow = !binding.rowScoped || item !== null;
    if (evaluated.value === undefined && hadRow) {
      emptyBindings.push(binding.where);
    }
  }

  if (emptyBindings.length > 0) {
    const shown = emptyBindings.slice(0, 8).join(", ");
    pushPageWarning(
      warnings,
      `these bindings resolved to nothing${
        emptyBindings.length > 8 ? ` (${emptyBindings.length} total)` : ""
      }: ${shown}. Check the field names against the dataset samples — and remember a predicate's context is the row, so page state needs $$.state.x.`,
    );
  }

  collectDataChecks(definition, data, warnings, polish);

  return { warnings, polish, samples };
};
