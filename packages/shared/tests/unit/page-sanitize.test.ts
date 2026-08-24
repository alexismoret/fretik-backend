import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import type { PageDataset, PageDefinition } from "../../src/schemas/pages";
import { PAGE_LIMITS } from "../../src/schemas/pages";
import {
  pushPageWarning,
  sanitizePageDefinition,
} from "../../src/services/pages/sanitize";

/**
 * `sanitizePageDefinition` covers the DATA half — datasets, variables,
 * operations. Whether the SFC COMPILES belongs to the compiler, which refuses
 * instead of warning.
 *
 * It does read the source for one thing: the ids the code asks the bridge for.
 * That is still a data question — a page requesting a dataset it never declared
 * is a broken contract, not a broken program, and it compiles perfectly.
 *
 * The two channels are tested apart on purpose: `warnings` is broken (a
 * reference to nothing, code that cannot return) — one channel since
 * unfinished. Merging one into the other would change what the model believes
 * about its own output.
 */

const OBJECT_TYPE_ID = "00000000-0000-4000-8000-000000000000";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";

const definition = (extra: Partial<PageDefinition> = {}): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "<template><div>x</div></template>" },
  ...extra,
});

describe("sanitize, don't reject", () => {
  test("the definition comes back untouched, whatever it warned about", () => {
    const input = definition({
      datasets: [
        {
          id: "totals",
          kind: "objects",
          mode: "aggregate",
          objectTypeId: OBJECT_TYPE_ID,
          metrics: [{ name: "spend", fn: "sum" }],
        },
      ],
    });
    const result = sanitizePageDefinition(input);
    expect(result.definition).toBe(input);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("a clean definition raises neither warnings nor polish", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        variables: [{ key: "stage", type: "string", initial: "won" }],
        datasets: [
          {
            id: "deals",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "stage", op: "eq", value: { var: "stage" } }],
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });
});

describe("variable references", () => {
  test("a filter var-ref to a declared variable is clean", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        variables: [{ key: "month", type: "string" }],
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "month", op: "eq", value: { var: "month" } }],
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });

  test("a filter var-ref to an undeclared variable warns, naming where", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "month", op: "eq", value: { var: "week" } }],
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"week"'));
    expect(found).toBeDefined();
    expect(found).toContain('dataset "sales" filter "month"');
    expect(found).toContain("does not declare");
  });

  test("an external dataset's args are walked at any depth", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "inbox",
            kind: "external",
            providerKey: "acme-mail",
            operation: "list_messages",
            args: { query: { folders: [{ var: "folder" }] } },
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"folder"'));
    expect(found).toBeDefined();
    expect(found).toContain('dataset "inbox" args');
  });

  test("an operation's args are checked the same way", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        operations: [
          {
            kind: "app",
            id: "create",
            providerKey: "acme-orders",
            action: "create_order",
            args: { reference: { var: "reference" } },
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"reference"'));
    expect(found).toBeDefined();
    expect(found).toContain('operation "create" args');
  });
});

describe("inline rows", () => {
  test("rows past the byte cap are warned, naming the way out", () => {
    const oversized = "x".repeat(PAGE_LIMITS.maxInlineBytes);
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [{ id: "dump", kind: "inline", rows: [{ blob: oversized }] }],
      }),
    );
    const found = warnings.find((w) => w.includes('dataset "dump"'));
    expect(found).toBeDefined();
    expect(found).toContain(
      `${Math.round(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB cap`,
    );
    expect(found).toContain("object type");
  });

  test("rows within the cap say nothing", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          { id: "targets", kind: "inline", rows: [{ q: "Q1", target: 100 }] },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });
});

describe("external datasets", () => {
  const external = (extra: Partial<PageDataset>): PageDataset => ({
    id: "inbox",
    kind: "external",
    providerKey: "acme-mail",
    operation: "list_messages",
    ...extra,
  });

  test("a plain dot path with indices passes", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [external({ resultPath: "value.items[0].rows" })],
      }),
    );
    expect(warnings).toEqual([]);
  });

  test("anything else is warned — it would resolve to nothing", () => {
    for (const resultPath of [
      "value..items",
      "items[*]",
      "value.items[abc]",
      "a b",
    ]) {
      const { warnings } = sanitizePageDefinition(
        definition({ datasets: [external({ resultPath })] }),
      );
      const found = warnings.find((w) => w.includes(resultPath));
      expect(found).toBeDefined();
      expect(found).toContain("not a plain dot path");
    }
  });

  test("naming both connectionId and providerKey warns — the pin wins", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [external({ connectionId: CONNECTION_ID })],
      }),
    );
    expect(warnings.some((p: string) => p.includes("the pin wins"))).toBe(true);
  });

  test("a bare pin gets the per-viewer note; a bare providerKey gets none", () => {
    const pinnedOnly = sanitizePageDefinition(
      definition({
        datasets: [
          external({ connectionId: CONNECTION_ID, providerKey: undefined }),
        ],
      }),
    );
    expect(
      pinnedOnly.warnings.some((p: string) =>
        p.includes("pins one connection"),
      ),
    ).toBe(true);

    const providerOnly = sanitizePageDefinition(
      definition({ datasets: [external({})] }),
    );
    expect(
      providerOnly.warnings.some((p: string) => p.includes("connection")),
    ).toBe(false);
  });

  test("operations carry the same pin notes", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        operations: [
          {
            kind: "app",
            id: "create",
            connectionId: CONNECTION_ID,
            providerKey: "acme-orders",
            action: "create_order",
          },
        ],
      }),
    );
    expect(
      warnings.some(
        (p: string) =>
          p.includes('operation "create"') && p.includes("the pin wins"),
      ),
    ).toBe(true);
  });
});

describe("warnings never duplicate", () => {
  test("pushPageWarning drops a message it already holds", () => {
    const warnings: string[] = [];
    pushPageWarning(warnings, "same finding");
    pushPageWarning(warnings, "same finding");
    pushPageWarning(warnings, "another finding");
    expect(warnings).toEqual(["same finding", "another finding"]);
  });

  test("pushPagePolish deduplicates the same way", () => {
    const warnings: string[] = [];
    pushPageWarning(warnings, "same note");
    pushPageWarning(warnings, "same note");
    expect(warnings).toEqual(["same note"]);
  });

  test("two identical findings through the sanitizer land once", () => {
    // Two filters on the same key referencing the same undeclared variable
    // produce byte-identical messages — the reader must see one.
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [
              { key: "month", op: "eq", value: { var: "week" } },
              { key: "month", op: "neq", value: { var: "week" } },
            ],
          },
        ],
      }),
    );
    expect(warnings).toHaveLength(1);
  });
});

/**
 * The contract vs the code. A page whose SFC asks the bridge for ids the
 * definition never declares renders entirely empty — the bridge answers
 * nothing, every figure falls to zero, every table shows its empty state.
 *
 * Measured on a real page (2026-08-16) that requested four datasets and
 * declared none. It compiled, it passed the mechanical render gate's overlay
 * and click checks, and THREE separate judges — the vision critic, the text
 * judge, and a comparative ranker — read it as a well-behaved page with no data
 * yet. On a screenshot that is exactly what it is. Nothing but the contract can
 * tell the two apart.
 */
describe("ids the code asks for", () => {
  const withSource = (source: string, extra: Partial<PageDefinition> = {}) =>
    sanitizePageDefinition(definition({ code: { source }, ...extra }));

  test("a requested dataset that is not declared is named", () => {
    const { warnings } = withSource(
      `<script setup>await fretik.data.query({ datasetIds: ['items', 'by_status'] })</script>`,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain('dataset "items"');
    expect(warnings.join(" ")).toContain('dataset "by_status"');
  });

  test("reading a result off the bridge counts as asking for it", () => {
    const { warnings } = withSource(
      `<script setup>const rows = res.datasets.total_budget?.rows</script>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dataset "total_budget"');
  });

  test("a declared dataset draws nothing", () => {
    const { warnings } = withSource(
      `<script setup>await fretik.data.query({ datasetIds: ['items'] }); res.datasets.items</script>`,
      {
        datasets: [
          { id: "items", kind: "objects", objectTypeId: OBJECT_TYPE_ID },
        ],
      },
    );
    expect(warnings).toEqual([]);
  });

  test("an operation the page never declared is named too", () => {
    const { warnings } = withSource(
      `<script setup>await fretik.ops.run('archive_item', { variables: {} })</script>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('operation "archive_item"');
  });

  // Chart.js takes a `datasets` key of its own, and its children are object
  // literals rather than a bridge lookup. A check that fired on every chart
  // would be noise on the most common component in the corpus.
  test("a chart config is not a bridge request", () => {
    const { warnings } = withSource(
      `<script setup>const config = { data: { labels, datasets: [{ data: [1, 2] }] } }</script>`,
    );
    expect(warnings).toEqual([]);
  });

  // An id built at runtime is unknowable statically, and warning about the
  // variable's NAME would be a false positive on a page that works.
  test("a computed id is left alone", () => {
    const { warnings } = withSource(
      `<script setup>await fretik.data.query({ datasetIds: [selectedId] })</script>`,
    );
    expect(warnings).toEqual([]);
  });
});

/**
 * The two false positives the first version produced on real pages. Both would
 * have fired on code that works, and a warning channel that cries wolf on
 * working pages is worse than no channel at all.
 */
describe("ids the code asks for — what is NOT a request", () => {
  const warnFor = (source: string) =>
    sanitizePageDefinition(definition({ code: { source } })).warnings;

  test("a spread is not a property access", () => {
    // `{ ...datasets.value }` puts a dot immediately before `datasets`; the
    // naive pattern read the third dot of `...` as the access.
    expect(
      warnFor(
        `<script setup>datasets.value = { ...datasets.value, ...result.datasets }</script>`,
      ),
    ).toEqual([]);
  });

  test("unwrapping a ref named datasets is not a request", () => {
    expect(warnFor(`<script setup>const all = state.datasets.value</script>`)) //
      .toEqual([]);
  });

  test("a method on Chart.js's datasets array is not a request", () => {
    expect(
      warnFor(`<script setup>config.data.datasets.map(d => d.data)</script>`),
    ).toEqual([]);
  });
});

/**
 * The variable keys the CODE sends, against the ones the page DECLARES.
 *
 * `resolvePageState` matches exactly and drops the rest, so a mismatch leaves
 * the variable on its initial and the control does nothing. Measured on the
 * stored corpus (2026-08-21): 2 of the 7 pages declaring a write sent camelCase
 * for snake_case variables. Nothing else can catch it — `render/harness.ts`
 * answers every `ops.run` with `ok` WITHOUT executing, because a review must
 * not write, so no rendered review ever sees the failure.
 */
describe("variable keys the code sends", () => {
  const warnFor = (source: string, keys: string[] = ["item_id"]) =>
    sanitizePageDefinition(
      definition({
        variables: keys.map((key) => ({ key, type: "string" })),
        code: { source },
      }),
    ).warnings.filter((warning) => warning.startsWith("the code sends"));

  test("a key that is not declared is named, with the declared ones", () => {
    const warnings = warnFor(
      `<script setup>fretik.ops.run("save", { variables: { itemId: x } })</script>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"itemId"');
    expect(warnings[0]).toContain("Declared: item_id");
  });

  test("a declared key is silent, shorthand included", () => {
    expect(
      warnFor(
        `<script setup>fretik.data.query({ variables: { item_id } })</script>`,
      ),
    ).toEqual([]);
  });

  test("a spread makes the site unreadable, so it is skipped whole", () => {
    // Not guessed at: the spread may carry the declared key. The same rule the
    // id scan follows — a warning about a page that works is worse than none.
    expect(
      warnFor(
        `<script setup>fretik.ops.run("save", { variables: { ...state, itemId: x } })</script>`,
      ),
    ).toEqual([]);
  });

  test("a nested object does not swallow the closing brace", () => {
    // The reason this reads a real AST: a character scanner has to track depth
    // and quotes to know which `}` ends the object, and gets `{ a: { b: 1 } }`
    // wrong or reads `"}"` inside a string as the end.
    const warnings = warnFor(
      `<script setup>fretik.data.query({ variables: { range: { from: "}" }, itemId: 1 } })</script>`,
      ["range"],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"itemId"');
  });

  test("a `variables` key on something that is not a bridge call is ignored", () => {
    expect(
      warnFor(
        `<script setup>const cfg = { variables: { itemId: 1 } }</script>`,
      ),
    ).toEqual([]);
  });

  test("source the compiler will refuse warns about nothing here", () => {
    // Unparseable code is the compiler's verdict to give, and it refuses the
    // write outright. Noise in front of that helps nobody.
    expect(warnFor(`<script setup>const = = =</script>`)).toEqual([]);
  });
});

/**
 * A metric that can only ever return NULL. `count` counts rows; every other
 * function needs a column, and without one the SQL composes a literal NULL —
 * so the page shows a blank figure that reads exactly like "the data says
 * zero". Caught at write time because at read time it looks like an answer.
 */
describe("metrics that cannot compute", () => {
  const aggregate = (metrics: PageDataset["metrics"]) =>
    sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "agg",
            kind: "objects",
            mode: "aggregate",
            objectTypeId: OBJECT_TYPE_ID,
            groupBy: "status",
            metrics,
          },
        ],
      }),
    ).warnings;

  test("sum without a key is named, with the field that is missing", () => {
    const warnings = aggregate([{ name: "total", fn: "sum" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('metric "total"');
    expect(warnings[0]).toContain("`key`");
  });

  test("count needs no key and says nothing", () => {
    expect(aggregate([{ name: "n", fn: "count" }])).toEqual([]);
  });

  test("every other function is covered, not just sum", () => {
    for (const fn of ["avg", "min", "max", "count_distinct"] as const) {
      expect(aggregate([{ name: "m", fn }])).toHaveLength(1);
    }
  });

  test("a metric with its key draws nothing", () => {
    expect(
      aggregate([{ name: "b", fn: "sum", key: "budget", kind: "money" }]),
    ).toEqual([]);
  });
});

/**
 * The two silent failures a page can ship looking finished, both measured on
 * real pages on 2026-08-22 and neither visible to anything downstream: the
 * review's click probe reads a success toast as a live control, and a component
 * handed an unknown colour renders without complaint.
 */
describe("a declared operation nothing runs", () => {
  const withOps = (source: string, ids: string[]) =>
    sanitizePageDefinition(
      definition({
        code: { source },
        operations: ids.map((id) => ({
          id,
          kind: "record" as const,
          mode: "update" as const,
          objectTypeId: OBJECT_TYPE_ID,
          recordId: { var: "row" },
          args: { stage: { var: "stage" } },
        })),
        variables: [
          { key: "row", type: "string" },
          { key: "stage", type: "string" },
        ],
      }),
    ).warnings.filter((w) => w.includes("never runs it"));

  test("an operation the source never calls is named", () => {
    const warnings = withOps("<template><div/></template>", ["archive"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"archive"');
  });

  test("an operation the source calls literally is not", () => {
    expect(
      withOps(
        "<template><div/></template><script setup>fretik.ops.run('archive', {})</script>",
        ["archive"],
      ),
    ).toEqual([]);
  });

  test("a computed id keeps every id it names as a literal, and still catches the rest", () => {
    const warnings = withOps(
      `<template><div/></template><script setup>
       const id = ready ? 'mark_read' : 'mark_unread'
       fretik.ops.run(id, {})
       </script>`,
      ["mark_read", "mark_unread", "move_messages"],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"move_messages"');
  });

  test("an apostrophe in the copy does not shift what counts as a literal", () => {
    // The naive `'([^']+)'` scan pairs this apostrophe with the next quote and
    // loses every literal after it — which is why the check tests one known id.
    expect(
      withOps(
        `<template><p>Échec de l'envoi</p></template><script setup>
         const id = flag ? 'archive' : 'archive'
         fretik.ops.run(id, {})
         </script>`,
        ["archive"],
      ),
    ).toEqual([]);
  });
});

describe("a colour no component knows", () => {
  const colours = (source: string) =>
    sanitizePageDefinition(definition({ code: { source } })).warnings.filter(
      (w) => w.includes("colour") || w.includes("Nuxt UI colour"),
    );

  test("a static hue on a Nuxt UI component is named", () => {
    const warnings = colours(
      '<template><UBadge color="violet">x</UBadge></template>',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("violet");
    expect(warnings[0]).toContain("var(--color-violet-500)");
  });

  test("a semantic alias says nothing", () => {
    expect(
      colours('<template><UBadge color="success">x</UBadge></template>'),
    ).toEqual([]);
  });

  test("a plain element is not a Nuxt UI component", () => {
    expect(colours('<template><div color="violet">x</div></template>')).toEqual(
      [],
    );
  });

  test("a hue parked in a colour-named property is suspected, since the prop is bound", () => {
    // The measured shape: the literal sits two hops from the `color` prop, so
    // reading the template alone sees nothing.
    const warnings = colours(
      `<template><UBadge :color="t.badgeColor">x</UBadge></template>
       <script setup>const t = { badgeColor: 'violet' }</script>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("badgeColor");
  });

  test("the same hue stays quiet once the page uses the documented recipe", () => {
    expect(
      colours(
        `<template><span :style="{ color: dot }"/></template>
         <script setup>const c = { dotColor: 'violet' }
         const dot = \`var(--color-\${c.dotColor}-500)\`</script>`,
      ),
    ).toEqual([]);
  });
});
