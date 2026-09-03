import { babelParse, parse as parseSfc } from "vue/compiler-sfc";
import { canonicalProviderKey } from "../../external-apps/canonical-provider-key";
import type { PageDefinition } from "../../schemas/pages";
import {
  PAGE_ACCENT_TOKENS,
  PAGE_COMPONENT_COLORS,
  PAGE_LIMITS,
  eachPageFile,
  eachPageVarRef,
} from "../../schemas/pages";
// One reading of a script, two readers: this pass and the lints.
import { isAstNode, propertyKeyName, visitAst } from "./lint/ast";

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

export interface SanitizedPage {
  definition: PageDefinition;
  warnings: string[];
  /**
   * The subset that is not advice. A write REFUSES on these, exactly as it does
   * on a compile error, because they name a runtime failure that is certain and
   * silent: the call reaches the bridge, the bridge has nothing to route it to,
   * and the page renders as if it worked. Everything the agent could reasonably
   * disagree with stays a warning.
   */
  errors: string[];
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
 * `fretik.ops.run(action.id, …)` — an id this pass cannot read. One of these
 * and the literal set above stops being the whole list of what the code runs,
 * so any check that reasons from its ABSENCE has to stand down.
 */
const OPS_RUN_COMPUTED_RE = /ops\s*\.\s*run\s*\(\s*(?!['"])/;

/**
 * Whether an exact quoted `"id"` occurs anywhere in the source.
 *
 * A substring test rather than a scan for every literal in the file: the naive
 * `'([^']+)'` pairing walks straight off the rails on real page source, where
 * French copy is full of apostrophes and each one shifts the pairing for
 * everything after it. Asking about ONE known id cannot drift.
 */
const appearsAsLiteral = (source: string, id: string): boolean =>
  source.includes(`'${id}'`) ||
  source.includes(`"${id}"`) ||
  source.includes(`\`${id}\``);

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

/**
 * The variable keys the SFC SENDS to the bridge — the `{ variables: { … } }` of
 * a `data.query` or an `ops.run`.
 *
 * This is the other half of the joint `checkVarRefs` already guards.
 * `resolvePageState` matches keys EXACTLY and drops what the page never
 * declared, so a source sending `recordId` at a variable declared `record_id`
 * leaves that variable on its initial. Measured on the stored corpus
 * (2026-08-21): **2 of the 7 pages that declare a write** send camelCase for
 * snake_case variables, and their buttons answer `no record id to act on — the
 * variable it reads is empty`.
 *
 * It has to be caught HERE and nowhere else. The rendered review cannot see it:
 * `render/harness.ts` answers every `ops.run` with `ok` without executing,
 * because a review must not write. So a save-time read of the source is the
 * only thing between a mismatch and the first person to click the button.
 *
 * Read from a real AST, not a regex, and the reason is the same one written
 * above `DATASETS_ACCESS_RE`: a character-level reader of a language mistakes
 * spreads and nested objects for what it is looking for, and a warning about a
 * page that works is worse than no warning. `babelParse` comes from
 * `vue/compiler-sfc`, which this package already compiles every page with —
 * exact reading, no new dependency. A call site carrying a spread or a computed
 * key is skipped WHOLE: what cannot be read literally is not guessed at.
 *
 * Scope stated: `<script>` only. A `variables` object written inline in the
 * TEMPLATE is not read, which costs a missed warning, never a false one.
 */
export const variableKeysSentByCode = (source: string): Set<string> => {
  const keys = new Set<string>();
  const { descriptor } = parseSfc(source);
  const script = descriptor.scriptSetup ?? descriptor.script;
  if (!script) return keys;

  let ast;
  try {
    ast = babelParse(script.content, {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch {
    // Unparseable source is the COMPILER's verdict to give, and it refuses the
    // write outright. Saying anything here would just be noise in front of it.
    return keys;
  }

  visitAst(ast.program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node["callee"];
    if (!isAstNode(callee) || callee.type !== "MemberExpression") return;
    const method = callee["property"];
    if (!isAstNode(method) || callee["computed"] === true) return;
    // `ops.run(...)` and `data.query(...)` — the two calls that carry state.
    if (method["name"] !== "run" && method["name"] !== "query") return;
    const args = node["arguments"];
    if (!Array.isArray(args)) return;
    for (const arg of args) {
      if (!isAstNode(arg) || arg.type !== "ObjectExpression") continue;
      const properties = arg["properties"];
      if (!Array.isArray(properties)) continue;
      for (const property of properties) {
        if (!isAstNode(property) || propertyKeyName(property) !== "variables") {
          continue;
        }
        const value = property["value"];
        if (!isAstNode(value) || value.type !== "ObjectExpression") continue;
        const entries = value["properties"];
        if (!Array.isArray(entries)) continue;
        const sent: string[] = [];
        for (const entry of entries) {
          if (!isAstNode(entry)) continue;
          const name = propertyKeyName(entry);
          // A spread or a computed key makes the whole site unreadable.
          if (name === null) return;
          sent.push(name);
        }
        for (const name of sent) keys.add(name);
      }
    }
  });
  return keys;
};

/**
 * Static `color="…"` attributes on `U*` components whose value is not one of
 * the seven semantic aliases.
 *
 * Worth a pass of its own because this failure is invisible from every other
 * angle: the prop has no validator, the compiler only sees a string, and the
 * component renders — just with no colour at all (see `PAGE_COMPONENT_COLORS`).
 * Measured on a real board (2026-08-22) carrying `violet`, `teal` and `orange`
 * badges, all of which drew grey.
 *
 * Static attributes only. `:color="x"` is a binding this pass cannot resolve,
 * and a warning about a page that works is worse than no warning.
 */
const invalidComponentColors = (source: string): Set<string> => {
  const found = new Set<string>();
  const valid = new Set<string>(PAGE_COMPONENT_COLORS);
  let root: unknown;
  try {
    root = parseSfc(source).descriptor.template?.ast;
  } catch {
    return found;
  }
  if (!root) return found;

  // Its own walker: the template AST types its nodes with a NUMERIC enum, so
  // `visitAst` — which recognises a node by a string `type` — walks straight
  // past every one of them. Recognise an element by its shape instead.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const tag = Reflect.get(node, "tag");
    const props = Reflect.get(node, "props");
    if (
      typeof tag === "string" &&
      /^U[A-Z]/.test(tag) &&
      Array.isArray(props)
    ) {
      for (const prop of props) {
        if (typeof prop !== "object" || prop === null) continue;
        if (Reflect.get(prop, "name") !== "color") continue;
        // A directive (`:color`) carries `arg`/`exp`, never a literal `value`.
        const value = Reflect.get(prop, "value");
        if (typeof value !== "object" || value === null) continue;
        const content = Reflect.get(value, "content");
        if (typeof content !== "string" || valid.has(content)) continue;
        found.add(content);
      }
    }
    walk(Reflect.get(node, "children"));
    // `v-if` holds its children one level deeper, under each branch.
    walk(Reflect.get(node, "branches"));
  };
  walk(root);
  return found;
};

/**
 * `badgeColor: "violet"` in the SCRIPT — a Tailwind hue parked in a
 * colour-named property.
 *
 * The measured board reached its `color` prop through `:color="t.badgeColor"`,
 * two hops and an index away from the literal, so the template pass above sees
 * nothing. Resolving that chain is not worth attempting; noticing the hue is.
 *
 * A hue in a colour-named property has exactly two destinations: the documented
 * `var(--color-<hue>-500)` recipe, or a `color` prop that will silently draw
 * nothing. So the suspicion is raised only when the source never uses the
 * recipe at all — a page doing it right stays quiet.
 */
const HUE_PROPERTY_RE = /\b(\w*[Cc]olor)\s*:\s*['"]([a-z]+)['"]/g;
const COLOR_VAR_RECIPE_RE = /var\(\s*--color-|theme\s*\.\s*color\s*\(/;

const suspectHueProperties = (source: string): Map<string, string> => {
  const found = new Map<string, string>();
  if (COLOR_VAR_RECIPE_RE.test(source)) return found;
  const hues = new Set<string>(PAGE_ACCENT_TOKENS);
  const valid = new Set<string>(PAGE_COMPONENT_COLORS);
  for (const match of source.matchAll(HUE_PROPERTY_RE)) {
    const [, key, value] = match;
    if (!key || !value || valid.has(value) || !hues.has(value)) continue;
    found.set(value, key);
  }
  return found;
};

/**
 * Fold every `providerKey` onto the spelling a connection row can carry, and
 * say so. The only repair this pass performs — everything else here reports.
 *
 * It earns the exception because the defect is silent, permanent and was
 * measured: a page built over Akanea WMS (2026-08-26) stored `akanea_wms`, the
 * Python module's name, where the connection says `akanea-wms`. Nothing failed;
 * `resolvePageConnection` simply matched no row, so every viewer saw "connect
 * your account" no matter what the team connected, and the page fell back to
 * rows it invented. `canonicalProviderKey` can only ever change a string that
 * was already unmatchable (see its header), so the fold is safe to apply blind
 * and needs no registry lookup — a key still unknown afterwards is refused by
 * `validatePageDefinitionConnections`, not repaired here.
 */
const repairProviderKeys = (
  definition: PageDefinition,
  warnings: string[],
): PageDefinition => {
  const repaired: string[] = [];
  const fold = <T extends { providerKey?: string }>(entry: T): T => {
    if (entry.providerKey === undefined) return entry;
    const folded = canonicalProviderKey(entry.providerKey);
    if (folded === entry.providerKey) return entry;
    repaired.push(`"${entry.providerKey}" → "${folded}"`);
    return { ...entry, providerKey: folded };
  };

  const datasets = definition.datasets.map(fold);
  const operations = definition.operations.map((operation) =>
    operation.kind === "app" ? fold(operation) : operation,
  );
  if (repaired.length === 0) return definition;

  pushPageWarning(
    warnings,
    `providerKey rewritten: ${[...new Set(repaired)].join(", ")}. The key is the one the connections list prints (kebab-case), NOT the Python module name — \`fretik_apps.akanea_wms\` is the module, \`akanea-wms\` is the key. Written the other way, the page resolves no connection and prompts every viewer to connect an app the team already has.`,
  );
  return { ...definition, datasets, operations };
};

export const sanitizePageDefinition = (
  input: PageDefinition,
): SanitizedPage => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const definition = repairProviderKeys(input, warnings);
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
    if (dataset.kind === "inline" && dataset.rows) {
      const bytes = JSON.stringify(dataset.rows).length;
      if (bytes > PAGE_LIMITS.maxInlineBytes) {
        pushPageWarning(
          warnings,
          `dataset "${dataset.id}": inline rows are ${Math.round(bytes / 1000).toString()}KB, over the ${Math.round(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB cap — query a collection instead`,
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
  //
  // These two REFUSE the write rather than warning. The scans are deliberately
  // literal-only (see `idsRequestedByCode`), so a hit is not a guess: the id is
  // written in the source, the definition does not carry it, and the call is
  // certain to reach a bridge with nothing to route it to — the same category
  // as a compile error, which already refuses.
  // Every file, as one text. These scans ask what the CODE mentions — a
  // dataset id, an operation id, a variable key — and a page's code is now
  // several files, any of which may be the one that calls the bridge.
  const code = eachPageFile(definition.code)
    .map(([, content]) => content)
    .join("\n");
  const requested = idsRequestedByCode(code);
  const operationIds = new Set(definition.operations.map((o) => o.id));
  for (const id of requested.datasets) {
    if (datasetIds.has(id)) continue;
    pushPageWarning(
      errors,
      `the code asks the bridge for dataset "${id}", which the page does not declare — it resolves to nothing and renders as an empty state. Declare it, or drop the request.`,
    );
  }
  for (const id of requested.operations) {
    if (operationIds.has(id)) continue;
    pushPageWarning(
      errors,
      `the code runs operation "${id}", which the page does not declare — the call fails at the bridge. Declare it, or drop the call.`,
    );
  }
  // The same joint from the DECLARATION side, and the sharper half. An
  // operation nothing runs is the shape a page takes when its controls only
  // pretend to write: measured on a real mail client (2026-08-22) that declared
  // nine operations, called three, and answered every other button with a
  // success toast. Nothing downstream catches it — a toast IS a DOM change, so
  // the review's click probe reads the control as live — and the page ships
  // looking finished. Skipped entirely when any id is computed, because then
  // the literal set above is not the whole list of what runs.
  //
  // When an id IS computed — `ops.run(isRead ? 'mark_read' : 'mark_unread')` —
  // the precise set stops being the whole list, so the test weakens to one that
  // stays sound: an id that appears nowhere in the source as a string literal
  // cannot be the one a computed expression resolves to. Measured on that same
  // page, this weaker form still names all three dead declarations.
  const computedOperationId = OPS_RUN_COMPUTED_RE.test(code);
  for (const operation of definition.operations) {
    const called = computedOperationId
      ? appearsAsLiteral(code, operation.id)
      : requested.operations.has(operation.id);
    if (called) continue;
    pushPageWarning(
      warnings,
      `the page declares operation "${operation.id}" and never runs it — the id appears in no \`fretik.ops.run\` call in the source, so every control that promises it is inert. Wire the control to it, or drop both.`,
    );
  }
  for (const color of invalidComponentColors(code)) {
    pushPageWarning(
      warnings,
      `color="${color}" is not a Nuxt UI colour — the component draws with no colour at all, silently. Use one of ${PAGE_COMPONENT_COLORS.join(", ")}; for a data hue, bind \`:style\` to \`var(--color-${color}-500)\` instead.`,
    );
  }
  for (const [hue, key] of suspectHueProperties(code)) {
    pushPageWarning(
      warnings,
      `"${key}: '${hue}'" holds a Tailwind hue, and this page never uses the \`var(--color-…)\` recipe — if it reaches a component's \`color\` prop, that component draws with no colour at all, silently. A \`color\` prop takes only ${PAGE_COMPONENT_COLORS.join(", ")}; a data hue belongs in \`:style\` as \`var(--color-${hue}-500)\`.`,
    );
  }
  // Same joint, the other side: the ids line up but the VARIABLE KEYS do not.
  const declaredList = [...variableKeys].join(", ");
  // An ERROR too, on the same terms: the key is in the source, the definition
  // does not declare it, and the server drops it — so the control the viewer
  // moves changes nothing while the page looks like it responded. It is the
  // softest of the three (the call still succeeds), so it is the first to
  // demote if it proves noisy on the existing corpus.
  for (const key of variableKeysSentByCode(code)) {
    if (variableKeys.has(key)) continue;
    pushPageWarning(
      errors,
      `the code sends variable "${key}", which the page does not declare — undeclared keys are dropped, so the variable it should fill keeps its initial and the control does nothing. Declared: ${declaredList || "none"}.`,
    );
  }

  return { definition, warnings, errors };
};
