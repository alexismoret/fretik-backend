/**
 * Format-agnostic readers over a stored page definition.
 *
 * The pages eval grades the definition the agent SAVED, and it must keep
 * grading it across format migrations — otherwise the baseline recorded
 * before a migration is not comparable to the score the migration is
 * accepted against. That comparability rests entirely on these readers being
 * blind to the shape:
 *
 *   - v1  `{ root: PageNode[] }`       — nested tree, `children`/`cells` recurse
 *   - v2  `{ spec: { elements: {} } }` — flat map, `children` are key refs
 *   - v3  `{ code: { source } }`       — one Vue SFC; the TEMPLATE is the tree
 *
 * All three are read here, so the same assertion scores any of them. For v3
 * there are no nodes to walk: the closest equivalent of "which components does
 * this page use" is the template's tags, so `collectNodes` returns one
 * pseudo-node per PascalCase component occurrence (plus `<canvas>`, where
 * Chart.js draws). Deliberately pure (zero imports): the eval case module
 * pulls the DB and services, and these functions have no business behind that
 * import cost — it also keeps them unit-testable without the service env.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The authored Vue SFC of a code page (v3); "" for shapes that have none. */
export const pageSource = (definition: unknown): string => {
  if (!isRecord(definition)) return "";
  const code = definition.code;
  return isRecord(code) && typeof code.source === "string" ? code.source : "";
};

/** Every node of a definition, whichever shape it uses. */
export const collectNodes = (
  definition: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(definition)) return [];
  const out: Record<string, unknown>[] = [];

  // Code form (v3): scan the SFC TEMPLATE for component tags — one pseudo-node
  // `{ type: tagName }` per opening-tag occurrence. PascalCase catches Nuxt UI
  // and any registered component; `<canvas>` is added explicitly because it is
  // the one lowercase tag that carries structure (a chart). Closing tags and
  // plain HTML stay uncounted, so prose-heavy pages are probed via
  // `pageSource`, not node counts.
  const source = pageSource(definition);
  if (source.trim().length > 0) {
    const templateStart = source.indexOf("<template");
    const templateEnd = source.lastIndexOf("</template>");
    const template =
      templateStart !== -1 && templateEnd > templateStart
        ? source.slice(templateStart, templateEnd)
        : source;
    for (const match of template.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
      const tag = match[1];
      if (tag) out.push({ type: tag });
    }
    const canvasCount = template.match(/<canvas\b/g)?.length ?? 0;
    for (let i = 0; i < canvasCount; i++) out.push({ type: "canvas" });
    return out;
  }

  // Nested form (v1): walk `root`, descending BOTH branches — `cells` (a
  // table's per-column subtree) is separate from `children`, and a reader that
  // forgets it under-counts every table page. Finds nothing on v3 shapes.
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (!isRecord(n)) return;
    if (typeof n.type === "string") out.push(n);
    walk(n.children);
    walk(n.cells);
  };
  walk(definition.root);

  // Flat form (v2): `spec.elements` (or `elements` at the top level). Children
  // are key references into the same map, so iterating the values is the whole
  // traversal — no recursion needed. Finds nothing on v3 shapes.
  const spec = isRecord(definition.spec) ? definition.spec : definition;
  if (isRecord(spec.elements)) {
    for (const el of Object.values(spec.elements)) {
      if (isRecord(el) && typeof el.type === "string") out.push(el);
    }
  }
  return out;
};

/** Datasets stay a sibling of the presentation in every format. */
export const collectDatasets = (
  definition: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(definition) || !Array.isArray(definition.datasets)) return [];
  return definition.datasets.filter(isRecord);
};

/**
 * Operations — the WRITE half, and the only place a page's ability to change
 * anything is recorded.
 *
 * Read from the definition rather than from the source on purpose: a template
 * can render a status select on every row and change nothing, which looks
 * identical to a working page until somebody reloads. What a page can do is
 * what it declared.
 */
export const collectOperations = (
  definition: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(definition) || !Array.isArray(definition.operations)) return [];
  return definition.operations.filter(isRecord);
};

/**
 * Whether the stored page would actually draw something.
 *
 * `collectNodes` counts elements; this asks the different question of whether
 * the renderer ENTERS the document at all. In the code format an empty
 * `code.source` renders literally nothing (the blank-page save the write gate
 * refuses); in the flat format a spec whose root names no entry paints a blank
 * screen no matter how many elements sit beside it (prod 2026-08-09); in the
 * nested format the equivalent is an empty `root` array.
 */
export const rendersSomething = (definition: unknown): boolean => {
  if (!isRecord(definition)) return false;
  if (isRecord(definition.code)) {
    return pageSource(definition).trim().length > 0;
  }
  const spec = isRecord(definition.spec) ? definition.spec : definition;
  if (isRecord(spec.elements)) {
    return (
      typeof spec.root === "string" &&
      spec.root.length > 0 &&
      isRecord(spec.elements[spec.root])
    );
  }
  return Array.isArray(definition.root) && definition.root.length > 0;
};

/** The node `type` of every node, in traversal order. */
export const nodeTypes = (definition: unknown): string[] =>
  collectNodes(definition).flatMap((n) =>
    typeof n.type === "string" ? [n.type] : [],
  );

/** True when any node's type matches — e.g. "is there a table on this page".
 * On v3 the types are template tag names (`UTable`, `canvas`, …). */
export const hasNodeMatching = (definition: unknown, re: RegExp): boolean =>
  nodeTypes(definition).some((t) => re.test(t));

/**
 * The whole definition as one string, for "does anything in here mention X"
 * probes (a field key, an object type id, a `{ "var": … }` reference). Shape-
 * blind by construction — on v3 the JSON includes `code.source`, so text
 * probes see the authored code too.
 */
export const definitionText = (definition: unknown): string => {
  try {
    return JSON.stringify(definition ?? {});
  } catch {
    return "";
  }
};
