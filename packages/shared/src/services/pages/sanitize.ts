import {
  pageComponentFacts,
  validatePageProps,
} from "@fretik/render/catalogs/pages";
import { SCALES } from "@fretik/render/core/scales";
import { pageExpressionSyntaxError } from "@fretik/render/runtime/expressions";
import type {
  PageAction,
  PageDefinition,
  PageElement,
  PageValue,
} from "../../schemas/pages";
import {
  PAGE_LIMITS,
  eachPageBinding,
  isPageBinding,
} from "../../schemas/pages";

/**
 * Sanitize an agent-authored page definition.
 *
 * Doctrine (the same one `manageWorkflow` uses for icons/colors/tool hints):
 * SANITIZE, DON'T REJECT. A cosmetic mistake — an off-catalog prop, a bad enum
 * value, a colour that doesn't exist — is dropped and reported as a warning,
 * never an error. A model that best-guesses stays unblocked, and the warnings
 * are what it reads to fix the page on the next turn.
 *
 * Structural problems that the renderer would silently swallow (a dangling
 * dataset id, an unknown state key, an expression that doesn't parse) are
 * ALSO warnings rather than errors: the agent frequently writes a page and
 * creates the missing field or dataset in the same conversation.
 *
 * TWO CHANNELS, kept apart on purpose:
 *   `warnings` — something is broken or was dropped.
 *   `polish`   — it works, but it will read as unfinished.
 * Merging them would teach the model to treat a defect as a matter of taste.
 *
 * Where a mistake has exactly one sensible reading — `span: 4` instead of
 * `"4"`, a pixel height instead of a size — it is COERCED silently rather than
 * dropped. A coercion the model cannot get wrong is not worth a warning.
 *
 * WHY THE STRUCTURAL CHECKS ARE OURS. json-render ships `validateSpec` and
 * `autoFixSpec`, and neither survives contact with this file:
 *
 *  - The one failure mode a flat map introduces — an element inside its own
 *    subtree — is the one `validateSpec` does not look for. Its own walk
 *    terminates on a `seen` set; the renderer's does not, so a cycle hangs the
 *    viewer's browser. That walk has to be written here regardless, and once
 *    written it answers dangling children and orphans in a line each.
 *  - `autoFixSpec` relocates `visible`/`on`/`repeat`/`watch` out of `props`,
 *    which must happen BEFORE prop validation or every one of them is reported
 *    as an unknown prop. Handing it our elements means widening them to the
 *    library's `UIElement` (props required, `visible` narrowed to its own
 *    condition union) and re-parsing what comes back — more adapter than fix.
 *
 * What the library does own is the CATALOG: which components exist, what props
 * they take, what events they fire. That is imported, never restated.
 *
 * Pure and db-free so both the API boundary and the tool's dry-run share it.
 */

export interface SanitizedPage {
  definition: PageDefinition;
  warnings: string[];
  /** Works, but reads as unfinished. Never blocks anything. */
  polish: string[];
}

/** Element fields a model routinely writes inside `props` by mistake. */
const ELEMENT_FIELDS = ["visible", "on", "repeat", "watch"] as const;

/**
 * What may appear inside a table cell. Narrow on purpose: a cell subtree is
 * mounted once PER ROW, so anything that queries, repeats or nests deeply
 * multiplies by the page size.
 */
const CELL_TYPES = new Set<string>([
  "box",
  "text",
  "rich_text",
  "badge",
  "icon",
  "avatar",
  "identity",
  "image",
  "progress",
  "link",
  "button",
  "tooltip",
  "kbd",
  "field",
]);

/**
 * Ceiling on child-edge traversals while pruning. A flat map can describe a
 * graph, not just a tree, so a pathological one could otherwise be walked an
 * exponential number of times. Far above any real page.
 */
const MAX_WALK_STEPS = 20_000;

interface SanitizeContext {
  datasetIds: Set<string>;
  stateKeys: Set<string>;
  operationIds: Set<string>;
  warnings: string[];
  polish: string[];
}

/**
 * Ceilings on the two channels. Past these the list stops teaching and starts
 * costing tokens — one broken page can otherwise emit a finding per element.
 */
const WARNING_CAP = 60;
const POLISH_CAP = 20;

/**
 * Rows above which a records dataset stops being a sensible transform INPUT.
 *
 * The sandbox reads its inputs whole and costs ~35 ms per MB, so this is not a
 * style rule — it is the line past which a page pays for an aggregation the
 * database would have done for free, in SQL, without moving the rows.
 */
const TRANSFORM_INPUT_ROWS = 500;

/**
 * The ONLY way anything joins these channels: deduped, and capped.
 *
 * Exported because `dryRunPage` appends to the very arrays this function
 * produces. It used to `push` onto them directly, which walked straight past
 * both the cap and the dedup — so the data-phase findings were unbounded while
 * the static ones were not.
 */
export const pushPageWarning = (warnings: string[], message: string): void => {
  if (warnings.length >= WARNING_CAP) return;
  if (!warnings.includes(message)) warnings.push(message);
};

export const pushPagePolish = (polish: string[], message: string): void => {
  if (polish.length >= POLISH_CAP) return;
  if (!polish.includes(message)) polish.push(message);
};

const warnOnce = (context: SanitizeContext, message: string): void => {
  pushPageWarning(context.warnings, message);
};

const polishOnce = (context: SanitizeContext, message: string): void => {
  pushPagePolish(context.polish, message);
};

const checkExpression = (
  context: SanitizeContext,
  source: string,
  where: string,
): void => {
  const error = pageExpressionSyntaxError(source);
  if (error)
    warnOnce(context, `${where}: expression does not parse — ${error}`);
};

const isPlainObject = (value: PageValue): value is Record<string, PageValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The state path of a two-way binding, or null when the prop is not one. */
const boundStatePath = (value: PageValue): string | null => {
  if (!isPlainObject(value)) return null;
  const path = value["$bindState"];
  return typeof path === "string" ? path : null;
};

/** `/month` → `month`. Nested paths keep only their head — that is the
 *  variable a declaration can name. */
const stateKeyOf = (pointer: string): string =>
  pointer.replace(/^\//, "").split("/")[0] ?? "";

/** Pixel heights the catalog no longer accepts, mapped onto the size scale. */
const heightPreset = (pixels: number): string =>
  pixels < 180
    ? "xs"
    : pixels < 250
      ? "sm"
      : pixels < 330
        ? "md"
        : pixels < 430
          ? "lg"
          : "xl";

/**
 * Lift the four element fields out of `props`.
 *
 * Placed there they are inert — the renderer reads them off the element — so
 * an element that should have been conditional renders unconditionally. It is
 * the single most common structural mistake a model makes with a flat spec,
 * which is why it is repaired rather than reported.
 */
const liftElementFields = (
  key: string,
  element: PageElement,
  context: SanitizeContext,
): PageElement => {
  const props = { ...(element.props ?? {}) };
  let lifted = element;
  for (const field of ELEMENT_FIELDS) {
    if (!(field in props)) continue;
    const value = props[field];
    delete props[field];
    warnOnce(
      context,
      `element "${key}": moved "${field}" out of props — it is a field on the element, and inside props it does nothing`,
    );
    if (lifted[field] === undefined && value !== undefined) {
      lifted = { ...lifted, [field]: value };
    }
  }
  return { ...lifted, props };
};

/** Coercions that must happen before the catalog sees the value. */
const coerceProps = (
  props: Record<string, PageValue>,
): Record<string, PageValue> => {
  const height = props["height"];
  // The catalog took pixel heights before it took a scale; a model that
  // learned the old shape writes `height: 320`.
  if (typeof height === "number" && height >= 20) {
    return { ...props, height: heightPreset(height) };
  }
  return props;
};

const checkAction = (
  context: SanitizeContext,
  where: string,
  action: PageAction,
): void => {
  for (const [name, value] of Object.entries(action.params ?? {})) {
    eachPageBinding(value, (source) =>
      checkExpression(context, source, `${where} param "${name}"`),
    );
  }
  const statePath = action.params?.["statePath"];
  if (typeof statePath === "string") {
    const key = stateKeyOf(statePath);
    if (key && !context.stateKeys.has(key)) {
      warnOnce(
        context,
        `${where}: ${action.action} writes "${statePath}", but no variable "${key}" is declared`,
      );
    }
  }
  const dataset = action.params?.["dataset"];
  if (
    action.action === "refetch" &&
    typeof dataset === "string" &&
    !context.datasetIds.has(dataset)
  ) {
    warnOnce(context, `${where}: refetch targets unknown dataset "${dataset}"`);
  }
  if (action.action === "run") {
    const operation = action.params?.["operation"];
    if (typeof operation !== "string" || operation.length === 0) {
      warnOnce(
        context,
        `${where}: run needs params.operation — the id of an entry in the definition's operations[]`,
      );
    } else if (!context.operationIds.has(operation)) {
      const known = [...context.operationIds].slice(0, 6).join(", ");
      warnOnce(
        context,
        `${where}: run targets unknown operation "${operation}"${known ? ` — declared: ${known}` : " — the page declares none"}`,
      );
    }
  }
};

const asActions = (
  binding: PageAction | PageAction[],
): readonly PageAction[] => (Array.isArray(binding) ? binding : [binding]);

/**
 * One element, checked against its catalog entry. Returns null when the
 * element cannot render at all and should leave the map.
 */
const sanitizeElement = (
  key: string,
  input: PageElement,
  context: SanitizeContext,
): PageElement | null => {
  const facts = pageComponentFacts(input.type);
  if (!facts) {
    warnOnce(
      context,
      `dropped element "${key}": unknown type "${input.type}" — get_catalog lists every component that exists.`,
    );
    return null;
  }
  const element = liftElementFields(key, input, context);
  const where = `element "${key}" (${element.type})`;

  // --- props ---
  const { props, issues } = validatePageProps(
    element.type,
    coerceProps(element.props ?? {}),
  );
  for (const issue of issues) warnOnce(context, `${where}: ${issue.message}`);

  const kept: Record<string, PageValue> = {};
  for (const [name, value] of Object.entries(props)) {
    // `validatePageProps` returns what it was given, so the values are still
    // page values — re-narrowed here rather than trusted across the boundary.
    if (!isShallowPageValue(value)) continue;
    kept[name] = value;
    eachPageBinding(value, (source) =>
      checkExpression(context, source, `${where} prop "${name}"`),
    );

    const path = boundStatePath(value);
    if (path) {
      const stateKey = stateKeyOf(path);
      if (stateKey && !context.stateKeys.has(stateKey)) {
        warnOnce(
          context,
          `${where}: "${name}" binds to "${path}", but no variable "${stateKey}" is declared`,
        );
      }
    }

    if (
      facts.datasetProps.includes(name) &&
      typeof value === "string" &&
      !context.datasetIds.has(value)
    ) {
      warnOnce(
        context,
        `${where}: dataset "${value}" does not exist on this page`,
      );
    }
  }

  // A control whose value is a fixed literal cannot change anything: it looks
  // interactive and is inert, which no warning at render time would reveal.
  for (const name of facts.bindable) {
    const value = kept[name];
    if (value === undefined) continue;
    if (boundStatePath(value) === null && !isPageBinding(value)) {
      warnOnce(
        context,
        `${where}: "${name}" is a fixed value, so nothing the viewer does can change it — bind it with { "$bindState": "/<variable>" }`,
      );
    }
  }

  if (facts.group === "chart" && kept["dataset"] === undefined) {
    warnOnce(context, `${where}: no dataset — the chart will render empty`);
  }

  if (element.visible !== undefined) {
    eachPageBinding(element.visible, (source) =>
      checkExpression(context, source, `${where} visible`),
    );
  }

  // --- events ---
  const on: Record<string, PageAction | PageAction[]> = {};
  for (const [event, binding] of Object.entries(element.on ?? {})) {
    if (!facts.events.includes(event)) {
      warnOnce(
        context,
        `${where}: dropped handler "${event}" — this component fires ${
          facts.events.length > 0 ? facts.events.join("/") : "no events"
        }`,
      );
      continue;
    }
    for (const action of asActions(binding)) {
      checkAction(context, `${where} on ${event}`, action);
    }
    on[event] = binding;
  }

  // --- watch ---
  const watch: Record<string, PageAction | PageAction[]> = {};
  for (const [path, binding] of Object.entries(element.watch ?? {})) {
    const stateKey = stateKeyOf(path);
    if (stateKey && stateKey !== "data" && !context.stateKeys.has(stateKey)) {
      warnOnce(
        context,
        `${where}: watches "${path}", but no variable "${stateKey}" is declared`,
      );
    }
    for (const action of asActions(binding)) {
      checkAction(context, `${where} watch ${path}`, action);
    }
    watch[path] = binding;
  }

  // --- repeat ---
  // Rows live in state under `/data/<id>`; a variable holding a list works too.
  let repeat = element.repeat;
  if (repeat) {
    const segments = repeat.statePath.replace(/^\//, "").split("/");
    const [head, second] = segments;
    const known =
      head === "data"
        ? second !== undefined && context.datasetIds.has(second)
        : head !== undefined && context.stateKeys.has(head);
    if (!known) {
      warnOnce(
        context,
        `${where}: repeat reads "${repeat.statePath}", which is neither a dataset (/data/<id>) nor a declared variable`,
      );
    }
    if (!facts.acceptsChildren) {
      warnOnce(
        context,
        `${where}: dropped repeat — this component takes no children, so there is nothing to repeat`,
      );
      repeat = undefined;
    }
  }

  // --- children ---
  let children = element.children;
  if (children && children.length > 0 && !facts.acceptsChildren) {
    warnOnce(context, `${where}: dropped children — this component takes none`);
    children = undefined;
  }

  return {
    type: element.type,
    ...(Object.keys(kept).length > 0 ? { props: kept } : {}),
    ...(children && children.length > 0 ? { children } : {}),
    ...(element.visible !== undefined ? { visible: element.visible } : {}),
    ...(Object.keys(on).length > 0 ? { on } : {}),
    ...(repeat ? { repeat } : {}),
    ...(Object.keys(watch).length > 0 ? { watch } : {}),
  };
};

/**
 * Structural narrowing at the one place a library boundary widens a value.
 *
 * SHALLOW on purpose — it re-narrows what the prop validator already checked,
 * so it does not descend. Named apart from the recursive `isPageValue` in
 * `schemas/pages`: two predicates sharing one name, with different depth, is a
 * trap for whoever reads the next call site.
 */
const isShallowPageValue = (value: unknown): value is PageValue => {
  if (value === null) return true;
  const kind = typeof value;
  return (
    kind === "string" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "object"
  );
};

interface TreeIssues {
  /** Reachable from the root, in the order the walk found them. */
  reachable: string[];
}

/**
 * Walk from the root, repairing what a flat map makes possible and a tree did
 * not: a child that is its own ancestor, a child key naming nothing, a
 * `table_cell` outside a table, a cell subtree that would be mounted once per
 * row. Children arrays are rewritten in place on the sanitized copy.
 */
const walkTree = (
  elements: Record<string, PageElement>,
  root: string,
  context: SanitizeContext,
): TreeIssues => {
  const reachable: string[] = [];
  const seen = new Set<string>();
  let steps = 0;
  let exhausted = false;
  /** Deepest nesting reached — `ancestors.size` is the depth at each visit. */
  let depth = 0;

  const visit = (
    key: string,
    ancestors: Set<string>,
    parentType: string | null,
    /** Depth inside a `table_cell` subtree, or null outside one. */
    cellDepth: number | null,
  ): void => {
    const element = elements[key];
    if (!element) return;
    if (ancestors.size > depth) depth = ancestors.size;
    if (!seen.has(key)) {
      seen.add(key);
      reachable.push(key);
    }

    if (element.type === "table_cell" && parentType !== "table") {
      warnOnce(
        context,
        `element "${key}": a table_cell only works as a direct child of a table`,
      );
    }
    if (cellDepth !== null && !CELL_TYPES.has(element.type)) {
      warnOnce(
        context,
        `element "${key}": "${element.type}" is not allowed inside a table cell — a cell renders once per row, so it takes ${[...CELL_TYPES].join("/")}`,
      );
    }
    if (cellDepth !== null && cellDepth > PAGE_LIMITS.maxCellDepth) {
      warnOnce(
        context,
        `element "${key}": a table cell nests at most ${PAGE_LIMITS.maxCellDepth.toString()} levels`,
      );
    }

    const kept: string[] = [];
    for (const child of element.children ?? []) {
      if (child === key || ancestors.has(child)) {
        warnOnce(
          context,
          `element "${key}": dropped child "${child}" — it is already one of its own ancestors, and the page would render forever`,
        );
        continue;
      }
      if (!elements[child]) {
        warnOnce(
          context,
          `element "${key}": child "${child}" does not exist, so that branch renders nothing`,
        );
        continue;
      }
      kept.push(child);
    }
    elements[key] =
      kept.length > 0
        ? { ...element, children: kept }
        : { ...element, children: undefined };

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(key);
    for (const child of kept) {
      steps += 1;
      if (steps > MAX_WALK_STEPS) {
        exhausted = true;
        return;
      }
      visit(
        child,
        nextAncestors,
        element.type,
        element.type === "table_cell"
          ? 1
          : cellDepth === null
            ? null
            : cellDepth + 1,
      );
    }
  };

  visit(root, new Set(), null, null);
  if (exhausted) {
    warnOnce(
      context,
      "the page's elements reference each other too many ways to check — simplify the tree",
    );
  }
  // The depth ceiling used to be checked ONLY at publish, so a page that nested
  // too far saved cleanly and then refused to publish, with nothing said in the
  // turn that wrote it. Warning here costs no extra walk: `ancestors.size` is
  // the depth, and the publish gate stays the hard stop.
  if (depth > PAGE_LIMITS.maxDepth) {
    warnOnce(
      context,
      `the page nests ${depth.toString()} levels deep; publishing refuses anything past ${PAGE_LIMITS.maxDepth.toString()} — flatten a branch by giving its children to a shared parent`,
    );
  }
  return { reachable };
};

/** Elements below one key, cells included — a cell mounts all of them per row. */
const subtreeSize = (
  elements: Record<string, PageElement>,
  key: string,
  seen: Set<string>,
): number => {
  if (seen.has(key)) return 0;
  seen.add(key);
  const element = elements[key];
  if (!element) return 0;
  return (element.children ?? []).reduce(
    (total, child) => total + subtreeSize(elements, child, seen),
    1,
  );
};

/**
 * A metric name a viewer would not recognise once humanised. `nb`, `m0`, `cnt`
 * are how a query writes to itself; a legend and an axis title need words.
 */
const isCrypticName = (name: string): boolean =>
  name.length <= 3 || /^m\d+$/.test(name);

/**
 * The "reads as unfinished" pass. Runs on the SANITIZED spec so it never
 * comments on props that were dropped anyway.
 */
const collectPolish = (
  definition: PageDefinition,
  context: SanitizeContext,
): void => {
  for (const dataset of definition.datasets) {
    for (const metric of dataset.metrics ?? []) {
      if (!metric.label && isCrypticName(metric.name)) {
        polishOnce(
          context,
          `dataset "${dataset.id}": metric "${metric.name}" has no label, so the legend, the axis and the tooltip will all read "${metric.name}". Give it label (and unit if it has one).`,
        );
      }
    }
    if (dataset.seriesBy && !dataset.groupBy) {
      polishOnce(
        context,
        `dataset "${dataset.id}": seriesBy without groupBy produces one series and no categories — you probably meant groupBy.`,
      );
    }
  }

  let heroes = 0;
  let stats = 0;
  let statsWithComparison = 0;
  const datasetById = new Map(definition.datasets.map((d) => [d.id, d]));

  for (const [key, element] of Object.entries(definition.spec.elements)) {
    const props = element.props ?? {};
    // A twelve-column grid is the one width where the author is expected to
    // place every child. The renderer gives a spanless child the whole row
    // rather than the single column CSS would, so nothing breaks — but a row
    // of four KPIs written without spans becomes four stacked bands, which is
    // never what was meant. Named per GRID, not per child: one grid of eight
    // would otherwise emit eight notes and crowd out everything else.
    if (element.type === "grid" && (props["cols"] ?? "12") === "12") {
      const spanless = (element.children ?? []).filter(
        (child) =>
          definition.spec.elements[child]?.props?.["span"] === undefined,
      );
      if (spanless.length > 1) {
        const share = Math.max(1, Math.floor(12 / spanless.length));
        polishOnce(
          context,
          `element "${key}": ${spanless.length.toString()} of its children have no span, so each takes a full row. Give them span: "${share.toString()}" to sit ${spanless.length.toString()} across.`,
        );
      }
    }
    if (element.type === "stat") {
      stats += 1;
      if (props["emphasis"] === "hero") heroes += 1;
      if (props["compare"] !== undefined || props["delta"] !== undefined) {
        statsWithComparison += 1;
      }
    }
    if (element.type.startsWith("chart_")) {
      const datasetId = props["dataset"];
      const dataset =
        typeof datasetId === "string" ? datasetById.get(datasetId) : undefined;
      if (dataset?.seriesBy && props["series"] === undefined) {
        warnOnce(
          context,
          `element "${key}": its dataset groups by a second dimension (seriesBy) but the chart does not name a \`series\` column, so every group would collapse into one flat line. Set series: "series".`,
        );
      }
    }
  }

  // `data.<id>[0]` on an UNORDERED record list. The row it lands on is whatever
  // the database returned first, so a record view built this way names a
  // different record on a different day. Measured on a real page whose hero
  // title read `data.declarations[0].numero_dae` over a two-row dataset.
  //
  // Aggregate datasets are exempt: `data.kpi[0].total` on a dataset with no
  // groupBy is the documented single-row KPI shape, and there is nothing to
  // order.
  for (const dataset of definition.datasets) {
    if (dataset.kind !== "objects" || dataset.mode !== "records") continue;
    if (dataset.sortBy) continue;
    const reads = new RegExp(
      `\\bdata\\.${dataset.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[0\\]`,
    );
    let named = false;
    for (const element of Object.values(definition.spec.elements)) {
      eachPageBinding(element.props ?? {}, (expression) => {
        if (reads.test(expression)) named = true;
      });
    }
    if (named) {
      warnOnce(
        context,
        `dataset "${dataset.id}": a binding reads [0] of it, but it lists records in no defined order — which row that is can change between visits. Add sortBy, or filter it down to the single record the page is about.`,
      );
    }
  }

  // A table over a `records` dataset pages SERVER-SIDE as soon as the type
  // holds more rows than one window. Two consequences the author cannot see
  // from the definition alone, so they are named here:
  for (const [key, element] of Object.entries(definition.spec.elements)) {
    if (element.type !== "table") continue;
    const datasetId = element.props?.["dataset"];
    if (typeof datasetId !== "string") continue;
    const dataset = datasetById.get(datasetId);
    if (dataset?.kind !== "objects" || dataset.mode === "aggregate") continue;

    // 1. A column total computed from one page is the sum of that page. It is
    //    hidden the moment the table becomes a window, so a page that relies on
    //    it silently loses its footer on the day the type grows.
    if (Array.isArray(element.props?.["totals"])) {
      polishOnce(
        context,
        `element "${key}": totals over a records table only hold while the whole type fits in one page — past that the table pages server-side and the footer disappears. Add an aggregate dataset (fn: "sum") for a total that always holds.`,
      );
    }

    // 2. A shared dataset moves under everyone. Turning the table's page
    //    replaces the rows every other element bound to it reads, so a KPI
    //    beside it would change when the reader paginates.
    const others = Object.entries(definition.spec.elements).filter(
      ([otherKey, other]) =>
        otherKey !== key && other.props?.["dataset"] === datasetId,
    );
    if (others.length > 0) {
      polishOnce(
        context,
        `dataset "${datasetId}" feeds the table "${key}" and ${others.length.toString()} other element(s). Paging the table re-queries it, so those elements would change under the reader — give the table a dataset of its own.`,
      );
    }
  }

  if (heroes > 1) {
    warnOnce(
      context,
      `${heroes.toString()} stats claim emphasis "hero" — at most one thing on a view can be the headline.`,
    );
  }
  if (stats >= 2 && statsWithComparison === 0) {
    polishOnce(
      context,
      `${stats.toString()} KPI tiles and not one comparison: a number with nothing to measure it against says very little. Add compare (previous value) so each shows its own delta.`,
    );
  }
};

export const sanitizePageDefinition = (
  definition: PageDefinition,
): SanitizedPage => {
  const context: SanitizeContext = {
    datasetIds: new Set(definition.datasets.map((dataset) => dataset.id)),
    stateKeys: new Set(definition.variables.map((variable) => variable.key)),
    operationIds: new Set(
      definition.operations.map((operation) => operation.id),
    ),
    warnings: [],
    polish: [],
  };

  // Dataset-level references and expressions.
  for (const dataset of definition.datasets) {
    for (const filter of dataset.filters ?? []) {
      if (isPageBinding(filter.value)) {
        checkExpression(
          context,
          filter.value.$,
          `dataset "${dataset.id}" filter "${filter.key}"`,
        );
      }
    }
    for (const input of dataset.inputs ?? []) {
      if (!context.datasetIds.has(input)) {
        warnOnce(
          context,
          `dataset "${dataset.id}": input "${input}" does not exist`,
        );
      }
      if (input === dataset.id) {
        warnOnce(
          context,
          `dataset "${dataset.id}": cannot take itself as input`,
        );
      }
    }
    if (dataset.kind === "transform" && dataset.code) {
      // A transform is the BODY of `(data, state) => …`, so code that never
      // returns evaluates to `undefined` and yields an empty dataset — which
      // reads exactly like "the query found nothing". Cheap to catch here,
      // confusing to debug at render time.
      if (!/\breturn\b/.test(dataset.code)) {
        warnOnce(
          context,
          `dataset "${dataset.id}": the code never returns, so the dataset would come back empty. It is the body of (data, state) => … — end it with \`return rows\`.`,
        );
      }
      // The transform reads its inputs whole, in memory, and its cost is linear
      // in their size (measured: ~35 ms per MB). A records input sized for a
      // table is fine; one sized to be summed is a GROUP BY that never happened.
      for (const inputId of dataset.inputs ?? []) {
        const input = definition.datasets.find((d) => d.id === inputId);
        if (input?.kind !== "objects" || input.mode === "aggregate") continue;
        if ((input.limit ?? 100) <= TRANSFORM_INPUT_ROWS) continue;
        polishOnce(
          context,
          `dataset "${dataset.id}" reads "${inputId}", which asks for ${(input.limit ?? 0).toString()} rows. A transform combines results the database already reduced — group and sum in an aggregate dataset, then transform the tens of rows it returns.`,
        );
      }
    }
    if (dataset.kind === "inline" && dataset.rows) {
      const bytes = JSON.stringify(dataset.rows).length;
      if (bytes > PAGE_LIMITS.maxInlineBytes) {
        warnOnce(
          context,
          `dataset "${dataset.id}": inline rows are ${Math.round(bytes / 1000).toString()}KB, over the ${Math.round(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB cap — query an object type instead`,
        );
      }
    }
    if (dataset.kind === "external") {
      // Args resolve against STATE only — the wave executor cannot promise
      // another dataset's rows are settled when this one fires upstream.
      eachPageBinding(dataset.args ?? {}, (expression) => {
        checkExpression(
          context,
          expression,
          `dataset "${dataset.id}" external args`,
        );
        if (/\bdata\s*\./.test(expression)) {
          warnOnce(
            context,
            `dataset "${dataset.id}": external args resolve against state only — "data." reads nothing here. Bind a variable instead.`,
          );
        }
      });
      if (dataset.resultPath) {
        const error = pageExpressionSyntaxError(dataset.resultPath);
        if (error) {
          warnOnce(
            context,
            `dataset "${dataset.id}": resultPath does not parse — ${error}`,
          );
        }
      }
      if (dataset.connectionId && dataset.providerKey) {
        polishOnce(
          context,
          `dataset "${dataset.id}" names both connectionId and providerKey — the pin wins, so the providerKey is decoration.`,
        );
      }
      if (dataset.connectionId && !dataset.providerKey) {
        polishOnce(
          context,
          `dataset "${dataset.id}" pins one connection. On a team page, providerKey lets each viewer read through their OWN connection — pin only when everyone should see this exact account.`,
        );
      }
    }
  }

  // --- theme ---
  let theme = definition.theme;
  const colorTokens: readonly string[] = SCALES.color;
  if (theme?.accent && !colorTokens.includes(theme.accent)) {
    warnOnce(
      context,
      `theme accent "${theme.accent}" is not a colour token — dropped`,
    );
    theme = { ...theme, accent: undefined };
  }

  // --- elements ---
  const elements: Record<string, PageElement> = {};
  for (const [key, element] of Object.entries(definition.spec.elements)) {
    const sanitized = sanitizeElement(key, element, context);
    if (sanitized) elements[key] = sanitized;
  }

  const { root } = definition.spec;
  if (root && !elements[root]) {
    warnOnce(
      context,
      `the root element "${root}" is not in the elements map, so the page renders nothing`,
    );
  }

  const { reachable } =
    root && elements[root]
      ? walkTree(elements, root, context)
      : { reachable: [] };

  // Custom table cells mount their subtree once per row, so both the subtree
  // and the table's page size are capped harder than the document at large.
  for (const key of reachable) {
    const element = elements[key];
    if (element?.type !== "table") continue;
    const cells = (element.children ?? []).filter(
      (child) => elements[child]?.type === "table_cell",
    );
    if (cells.length === 0) continue;
    for (const cell of cells) {
      const size = subtreeSize(elements, cell, new Set()) - 1;
      if (size > PAGE_LIMITS.maxCellElements) {
        warnOnce(
          context,
          `element "${cell}": ${size.toString()} elements inside one table cell, the ceiling is ${PAGE_LIMITS.maxCellElements.toString()} — each one is mounted for every row`,
        );
      }
    }
    const pageSize = element.props?.["pageSize"];
    if (
      typeof pageSize === "number" &&
      pageSize > PAGE_LIMITS.maxCellPageSize
    ) {
      elements[key] = {
        ...element,
        props: { ...element.props, pageSize: PAGE_LIMITS.maxCellPageSize },
      };
    }
  }

  for (const key of Object.keys(elements)) {
    if (!reachable.includes(key)) {
      warnOnce(
        context,
        `element "${key}" is not reachable from the root, so it never renders — give it a parent or drop it`,
      );
    }
  }

  if (reachable.length > PAGE_LIMITS.maxElements) {
    warnOnce(
      context,
      `the page renders ${reachable.length.toString()} elements; the ceiling is ${PAGE_LIMITS.maxElements.toString()} and the rest was dropped`,
    );
    for (const key of reachable.slice(PAGE_LIMITS.maxElements)) {
      delete elements[key];
    }
  }

  const sanitized: PageDefinition = {
    ...definition,
    theme,
    spec: { root, elements },
  };
  collectPolish(sanitized, context);

  return {
    definition: sanitized,
    warnings: context.warnings,
    polish: context.polish,
  };
};
