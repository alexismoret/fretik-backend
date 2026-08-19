import type { PageDefinition } from "../../schemas/pages";
import { PAGE_LIMITS, eachPageVarRef } from "../../schemas/pages";

/**
 * Static pass over the DATA half of a page definition — datasets, variables,
 * operations. Doctrine: SANITIZE, DON'T REJECT — a definition with a dangling
 * reference still saves, and every finding comes back as a warning the agent
 * fixes in the same turn.
 *
 * ONE channel. It used to be two — `warnings` for broken, `polish` for "works
 * but reads as unfinished" — and the split was retired on 2026-08-15: it cost a
 * parallel array through four services and a sentence of tool description to
 * carry three messages, and it asked the agent to triage what it should simply
 * fix. Everything here is now a `warning`; taste-level feedback belongs to
 * `managePage { action: "review" }`, which has actually seen the page.
 *
 * The PRESENTATION half (the Vue SFC) is validated by the COMPILER
 * (`services/pages/compile.ts`), which refuses the write outright on failure —
 * code is binary, a definition is not.
 */

const WARNING_CAP = 60;

/** A transform reads its inputs whole, in memory — an input sized past this
 * is a GROUP BY that never happened. */
const TRANSFORM_INPUT_ROWS = 500;

export interface SanitizedPage {
  definition: PageDefinition;
  warnings: string[];
}

export const pushPageWarning = (warnings: string[], message: string): void => {
  if (warnings.length >= WARNING_CAP || warnings.includes(message)) return;
  warnings.push(message);
};

/** Property/index dot path: `value.items[0].rows`. */
const RESULT_PATH_RE =
  /^[a-zA-Z_$][\w$]*(\[\d+\])*(\.[a-zA-Z_$][\w$]*(\[\d+\])*)*$/;

/** `datasetIds: ['a', 'b']` — the literal array form only. */
const DATASET_IDS_RE = /datasetIds\s*:\s*\[([^\]]*)\]/g;
/**
 * `res.datasets.total_budget` / `.datasets['total_budget']`.
 *
 * The lookbehind rejects a SPREAD: `{ ...datasets.value }` puts a dot right
 * before `datasets`, so the naive pattern read the third dot of `...` as a
 * property access and reported a page that works. Measured on a real page,
 * where `datasets` was a Vue ref.
 */
const DATASETS_ACCESS_RE =
  /(?<!\.)\.datasets(?:\.([\w$]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;
/** Never a dataset id: a ref unwrap, or a method on the array Chart.js calls
 * `datasets`. Cheaper and more honest than trying to prove the receiver came
 * from the bridge. */
const NOT_AN_ID = new Set([
  "value",
  "length",
  "map",
  "filter",
  "find",
  "forEach",
  "some",
  "every",
  "reduce",
  "slice",
  "at",
  "push",
  "concat",
  "includes",
  "indexOf",
  "join",
  "sort",
  "keys",
  "values",
  "entries",
]);
/** `fretik.ops.run('archive', …)` — the literal id form only. */
const OPS_RUN_RE = /ops\s*\.\s*run\s*\(\s*['"]([^'"]+)['"]/g;
const STRING_LITERAL_RE = /['"]([^'"]+)['"]/g;

/**
 * Ids the SFC asks the bridge for at runtime. Literal forms only: an id built
 * from a variable is unknowable here, and guessing would warn about a page that
 * works.
 */
const idsRequestedByCode = (
  source: string,
): { datasets: Set<string>; operations: Set<string> } => {
  const datasets = new Set<string>();
  const operations = new Set<string>();
  for (const match of source.matchAll(DATASET_IDS_RE)) {
    for (const literal of (match[1] ?? "").matchAll(STRING_LITERAL_RE)) {
      if (literal[1]) datasets.add(literal[1]);
    }
  }
  for (const match of source.matchAll(DATASETS_ACCESS_RE)) {
    const id = match[1] ?? match[2];
    if (id && !NOT_AN_ID.has(id)) datasets.add(id);
  }
  for (const match of source.matchAll(OPS_RUN_RE)) {
    if (match[1]) operations.add(match[1]);
  }
  return { datasets, operations };
};

export const sanitizePageDefinition = (
  definition: PageDefinition,
): SanitizedPage => {
  const warnings: string[] = [];
  const datasetIds = new Set(definition.datasets.map((dataset) => dataset.id));
  const variableKeys = new Set(
    definition.variables.map((variable) => variable.key),
  );

  const checkVarRefs = (value: unknown, where: string): void => {
    eachPageVarRef(value as Parameters<typeof eachPageVarRef>[0], (key) => {
      if (!variableKeys.has(key)) {
        pushPageWarning(
          warnings,
          `${where}: { "var": "${key}" } references a variable the page does not declare — declare it, or the value resolves to nothing.`,
        );
      }
    });
  };

  const checkConnectionPin = (
    kindLabel: string,
    id: string,
    connectionId: string | undefined,
    providerKey: string | undefined,
  ): void => {
    if (connectionId && providerKey) {
      pushPageWarning(
        warnings,
        `${kindLabel} "${id}" names both connectionId and providerKey — the pin wins, so the providerKey is decoration.`,
      );
    }
    if (connectionId && !providerKey) {
      pushPageWarning(
        warnings,
        `${kindLabel} "${id}" pins one connection. On a team page, providerKey lets each viewer act through their OWN connection — pin only when everyone should use that exact account.`,
      );
    }
  };

  for (const dataset of definition.datasets) {
    for (const filter of dataset.filters ?? []) {
      checkVarRefs(
        filter.value,
        `dataset "${dataset.id}" filter "${filter.key}"`,
      );
    }
    for (const input of dataset.inputs ?? []) {
      if (!datasetIds.has(input)) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": input "${input}" does not exist`,
        );
      }
      if (input === dataset.id) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": cannot take itself as input`,
        );
      }
    }
    // `count` counts rows; every other function needs a column to work on, and
    // without one the metric compiles to a literal NULL. The figure then reads
    // as blank or zero on the page — indistinguishable from "the data says
    // zero", which is the worst way for a mistake to present itself.
    for (const metric of dataset.metrics ?? []) {
      if (metric.fn === "count" || metric.key) continue;
      pushPageWarning(
        warnings,
        `dataset "${dataset.id}" metric "${metric.name}": ${metric.fn} needs a \`key\` naming the field to aggregate — without one it always returns nothing, which the page shows as a blank figure.`,
      );
    }
    if (dataset.kind === "transform" && dataset.code) {
      // A transform is the BODY of `(data, state) => …`, so code that never
      // returns evaluates to `undefined` and yields an empty dataset — which
      // reads exactly like "the query found nothing". Cheap to catch here,
      // confusing to debug at render time.
      if (!/\breturn\b/.test(dataset.code)) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": the code never returns, so the dataset would come back empty. It is the body of (data, state) => … — end it with \`return rows\`.`,
        );
      }
      for (const inputId of dataset.inputs ?? []) {
        const input = definition.datasets.find((d) => d.id === inputId);
        if (input?.kind !== "objects" || input.mode === "aggregate") continue;
        if ((input.limit ?? 100) <= TRANSFORM_INPUT_ROWS) continue;
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}" reads "${inputId}", which asks for ${(input.limit ?? 0).toString()} rows. A transform combines results the database already reduced — group and sum in an aggregate dataset, then transform the tens of rows it returns.`,
        );
      }
    }
    if (dataset.kind === "inline" && dataset.rows) {
      const bytes = JSON.stringify(dataset.rows).length;
      if (bytes > PAGE_LIMITS.maxInlineBytes) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": inline rows are ${Math.round(bytes / 1000).toString()}KB, over the ${Math.round(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB cap — query an object type instead`,
        );
      }
    }
    if (dataset.kind === "external") {
      checkVarRefs(dataset.args ?? {}, `dataset "${dataset.id}" args`);
      if (dataset.resultPath && !RESULT_PATH_RE.test(dataset.resultPath)) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": resultPath "${dataset.resultPath}" is not a plain dot path (like "value.items" or "data.rows[0].list") — it will resolve to nothing.`,
        );
      }
      checkConnectionPin(
        "dataset",
        dataset.id,
        dataset.connectionId,
        dataset.providerKey,
      );
    }
  }

  for (const operation of definition.operations) {
    if (operation.kind === "app") {
      checkVarRefs(operation.args ?? {}, `operation "${operation.id}" args`);
      checkConnectionPin(
        "operation",
        operation.id,
        operation.connectionId,
        operation.providerKey,
      );
      continue;
    }
    if (operation.kind === "link") {
      checkVarRefs(
        operation.fromRecordId,
        `operation "${operation.id}" fromRecordId`,
      );
      checkVarRefs(
        operation.toRecordId,
        `operation "${operation.id}" toRecordId`,
      );
      continue;
    }
    checkVarRefs(operation.args ?? {}, `operation "${operation.id}" args`);
    checkVarRefs(
      operation.kind === "bulk" ? operation.recordIds : operation.recordId,
      `operation "${operation.id}" ${operation.kind === "bulk" ? "recordIds" : "recordId"}`,
    );
    // `args` IS the writable-field allowlist, so an update with none of them
    // reaches the row and changes nothing — a button that saves an empty patch
    // and reports success is indistinguishable from one that works.
    if (
      operation.mode === "update" &&
      Object.keys(operation.args ?? {}).length === 0
    ) {
      pushPageWarning(
        warnings,
        `operation "${operation.id}": an update with no args writes nothing — args names the fields it changes, and nothing outside them can reach the record.`,
      );
    }
  }

  // The contract vs the code. A page whose SFC asks the bridge for ids the
  // definition never declares LOOKS finished and renders entirely empty: the
  // bridge answers nothing, every figure falls to zero, every table shows its
  // empty state. Measured on a real page (2026-08-16) that asked for four
  // datasets and declared none — three separate judges, vision and text, read
  // it as a well-behaved page with no data yet, because on a screenshot that is
  // exactly what it is. Structural, so checked structurally.
  const requested = idsRequestedByCode(definition.code.source);
  const operationIds = new Set(definition.operations.map((o) => o.id));
  for (const id of requested.datasets) {
    if (datasetIds.has(id)) continue;
    pushPageWarning(
      warnings,
      `the code asks the bridge for dataset "${id}", which the page does not declare — it resolves to nothing and renders as an empty state. Declare it, or drop the request.`,
    );
  }
  for (const id of requested.operations) {
    if (operationIds.has(id)) continue;
    pushPageWarning(
      warnings,
      `the code runs operation "${id}", which the page does not declare — the call fails at the bridge. Declare it, or drop the call.`,
    );
  }

  return { definition, warnings };
};
