/**
 * Format-agnostic readers over a stored page definition.
 *
 * The pages eval grades the definition the agent SAVED, and it must keep
 * grading it across the json-render refonte — otherwise the baseline recorded
 * before the migration is not comparable to the score the migration is
 * accepted against. That comparability rests entirely on these readers being
 * blind to the tree shape:
 *
 *   - today  `{ root: PageNode[] }`      — nested, `children` / `cells` recurse
 *   - after  `{ spec: { elements: {} } }` — flat map, `children` are key refs
 *
 * Both are read here, so the same assertion scores either. Deliberately pure
 * (zero imports): the eval case module pulls the DB and services, and these
 * functions have no business behind that import cost — it also keeps them
 * unit-testable without the service env.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every node of a definition, whichever tree shape it uses. */
export const collectNodes = (
  definition: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(definition)) return [];
  const out: Record<string, unknown>[] = [];

  // Nested form: walk `root`, descending BOTH branches — `cells` (a table's
  // per-column subtree) is separate from `children`, and a reader that forgets
  // it under-counts every table page.
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

  // Flat form: `spec.elements` (or `elements` at the top level). Children are
  // key references into the same map, so iterating the values is the whole
  // traversal — no recursion needed.
  const spec = isRecord(definition.spec) ? definition.spec : definition;
  if (isRecord(spec.elements)) {
    for (const el of Object.values(spec.elements)) {
      if (isRecord(el) && typeof el.type === "string") out.push(el);
    }
  }
  return out;
};

/** Datasets stay a sibling of the tree in both formats. */
export const collectDatasets = (
  definition: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(definition) || !Array.isArray(definition.datasets)) return [];
  return definition.datasets.filter(isRecord);
};

/**
 * Whether the stored page would actually draw something.
 *
 * `collectNodes` counts elements; this asks the different question of whether
 * the renderer ENTERS the document at all. In the flat format a spec whose
 * root names no entry paints a blank screen no matter how many elements sit
 * beside it (prod 2026-08-09), and in the nested format the equivalent is an
 * empty `root` array.
 */
export const rendersSomething = (definition: unknown): boolean => {
  if (!isRecord(definition)) return false;
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

/** True when any node's type matches — e.g. "is there a chart on this page". */
export const hasNodeMatching = (definition: unknown, re: RegExp): boolean =>
  nodeTypes(definition).some((t) => re.test(t));

/**
 * The whole definition as one string, for "does anything in here mention X"
 * probes (a field key, an object type id, a state reference). Shape-blind by
 * construction, which is exactly why it survives the refonte.
 */
export const definitionText = (definition: unknown): string => {
  try {
    return JSON.stringify(definition ?? {});
  } catch {
    return "";
  }
};
