import type { PageDefinition } from "../../schemas/pages";
import { PAGE_LIMITS, eachPageVarRef } from "../../schemas/pages";

/**
 * Static pass over the DATA half of a page definition — datasets, variables,
 * operations. Doctrine: SANITIZE, DON'T REJECT — a definition with a dangling
 * reference still saves, and every finding comes back as a warning the agent
 * fixes in the same turn.
 *
 * Two channels, kept apart on purpose:
 * - `warnings` = broken (a reference to nothing, code that cannot return);
 * - `polish`   = works but reads as unfinished (an unpinned connection note).
 *
 * The PRESENTATION half (the Vue SFC) is validated by the COMPILER
 * (`services/pages/compile.ts`), which refuses the write outright on failure —
 * code is binary, a definition is not.
 */

const WARNING_CAP = 60;
const POLISH_CAP = 20;

/** A transform reads its inputs whole, in memory — an input sized past this
 * is a GROUP BY that never happened. */
const TRANSFORM_INPUT_ROWS = 500;

export interface SanitizedPage {
  definition: PageDefinition;
  warnings: string[];
  /** Works, but reads as unfinished. Never blocks anything. */
  polish: string[];
}

export const pushPageWarning = (warnings: string[], message: string): void => {
  if (warnings.length >= WARNING_CAP || warnings.includes(message)) return;
  warnings.push(message);
};

export const pushPagePolish = (polish: string[], message: string): void => {
  if (polish.length >= POLISH_CAP || polish.includes(message)) return;
  polish.push(message);
};

/** Property/index dot path: `value.items[0].rows`. */
const RESULT_PATH_RE =
  /^[a-zA-Z_$][\w$]*(\[\d+\])*(\.[a-zA-Z_$][\w$]*(\[\d+\])*)*$/;

export const sanitizePageDefinition = (
  definition: PageDefinition,
): SanitizedPage => {
  const warnings: string[] = [];
  const polish: string[] = [];
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
      pushPagePolish(
        polish,
        `${kindLabel} "${id}" names both connectionId and providerKey — the pin wins, so the providerKey is decoration.`,
      );
    }
    if (connectionId && !providerKey) {
      pushPagePolish(
        polish,
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
        pushPagePolish(
          polish,
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
    checkVarRefs(operation.args ?? {}, `operation "${operation.id}" args`);
    checkConnectionPin(
      "operation",
      operation.id,
      operation.connectionId,
      operation.providerKey,
    );
  }

  return { definition, warnings, polish };
};
