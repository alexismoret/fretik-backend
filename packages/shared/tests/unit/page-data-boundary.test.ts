import { describe, expect, mock, test } from "bun:test";
// `schemas/ontology` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod. In a service
// that happens at boot; here it has to be imported for the side effect.
import "@hono/zod-openapi";
import type {
  PageDataset,
  PageDefinition,
  PageValue,
  PageVariable,
} from "../../src/schemas/pages";
import { PAGE_LIMITS, PageDataRequestSchema } from "../../src/schemas/pages";

/**
 * The page DATA path: the security boundary, dataset orchestration, and the
 * two allowlists that decide what an anonymous viewer can reach.
 *
 * This is the half of the feature the unit suite never covered — it was only
 * ever checked by hand over HTTP. What it protects is precise: a viewer's
 * browser may send values for the variables a page DECLARES, and nothing else.
 * Object type, filter keys and operators all come from the stored definition,
 * so a forged body cannot widen a page's reach.
 *
 * The db and the two record services are mocked at module level — the dynamic
 * imports below resolve AFTER, and let the tests read back exactly which
 * filters and limits reached the query layer.
 */

/** Object type ids the mocked db "knows"; anything else resolves forbidden. */
const knownObjectTypes = new Set<string>(["type-1"]);
/** Field definitions the mocked team owns, per object type. */
let fieldDefinitions: unknown[] = [];
/** Every call the objects source made into the record services. */
const listCalls: Record<string, unknown>[] = [];
const aggregateCalls: Record<string, unknown>[] = [];
let listResult: { count: number; data: unknown[] } = { count: 0, data: [] };

void mock.module("../../src/db", () => ({
  default: {
    query: {
      objectTypes: {
        findFirst: (args: { where?: { id?: string } }) =>
          Promise.resolve(
            args.where?.id !== undefined && knownObjectTypes.has(args.where.id)
              ? { id: args.where.id }
              : undefined,
          ),
        findMany: () => Promise.resolve([]),
      },
    },
  },
}));

void mock.module("../../src/services/object-records/retrieve", () => ({
  listObjectRecords: (params: Record<string, unknown>) => {
    listCalls.push(params);
    return Promise.resolve(listResult);
  },
}));

void mock.module("../../src/services/object-records/aggregate", () => ({
  aggregateRecords: (params: Record<string, unknown>) => {
    aggregateCalls.push(params);
    return Promise.resolve({ rows: [], truncated: false });
  },
}));

void mock.module("../../src/services/field-definitions/get-for-team", () => ({
  getFieldDefinitionsForTeam: () => Promise.resolve(fieldDefinitions),
}));

const { resolvePageState, runPageData } =
  await import("../../src/services/pages/run-page-data");
const { buildPageFieldDescriptors } =
  await import("../../src/services/pages/field-descriptors");
const { objectsSource } =
  await import("../../src/services/pages/sources/objects");

const page = (
  variables: PageVariable[],
  datasets: PageDataset[] = [],
): PageDefinition => ({
  version: 3,
  variables,
  datasets,
  operations: [],
  code: { source: "<template><div>x</div></template>" },
});

const inline = (
  id: string,
  rows: Record<string, PageValue>[],
): PageDataset => ({
  id,
  kind: "inline",
  rows,
});

describe("resolvePageState — the security boundary", () => {
  test("a variable the page does not declare never reaches state", () => {
    const state = resolvePageState(page([]), {
      objectTypeId: "type-evil",
      filters: [{ key: "amount", op: "gt", value: 0 }],
      teamId: "another-team",
      userId: null,
    });
    expect(state).toEqual({});
  });

  test("declared variables survive; undeclared ones are dropped alongside", () => {
    const state = resolvePageState(
      page([{ key: "status", type: "string", initial: "open" }]),
      { status: "won", objectTypeId: "type-evil" },
    );
    expect(state).toEqual({ status: "won" });
  });

  test("a value of the wrong type falls back to the declared initial", () => {
    const state = resolvePageState(
      page([{ key: "limit", type: "number", initial: 10 }]),
      { limit: "999; DROP TABLE" },
    );
    expect(state).toEqual({ limit: 10 });
  });

  test("a missing value with no initial resolves to null, never undefined", () => {
    const state = resolvePageState(page([{ key: "q", type: "string" }]), {});
    expect(state).toEqual({ q: null });
    expect(Object.hasOwn(state, "q")).toBe(true);
  });

  test("each declared type coerces or rejects on its own terms", () => {
    const definition = page([
      { key: "s", type: "string" },
      { key: "n", type: "number" },
      { key: "b", type: "boolean" },
      { key: "l", type: "string_list" },
      { key: "d", type: "date_range" },
      { key: "j", type: "json" },
    ]);
    const state = resolvePageState(definition, {
      s: "text",
      n: 42,
      b: true,
      l: ["a", "b"],
      d: { start: "2026-01-01", end: "2026-12-31" },
      j: { anything: [1, 2, 3] },
    });
    expect(state).toEqual({
      s: "text",
      n: 42,
      b: true,
      l: ["a", "b"],
      d: { start: "2026-01-01", end: "2026-12-31" },
      j: { anything: [1, 2, 3] },
    });
  });

  test("a string_list holding a non-string is rejected whole", () => {
    const state = resolvePageState(
      page([{ key: "tags", type: "string_list", initial: ["default"] }]),
      { tags: ["ok", 7] },
    );
    expect(state).toEqual({ tags: ["default"] });
  });

  test("a date_range missing an end is rejected", () => {
    const state = resolvePageState(
      page([{ key: "range", type: "date_range" }]),
      { range: { start: "2026-01-01" } },
    );
    expect(state).toEqual({ range: null });
  });
});

describe("runPageData — orchestration and degradation", () => {
  test("inline rows come back under their dataset id", async () => {
    const { datasets } = await runPageData({
      definition: page([], [inline("sales", [{ amount: 10 }])]),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.sales).toEqual({
      status: "ok",
      rows: [{ amount: 10 }],
      truncated: false,
    });
  });

  test("a transform runs after the dataset it depends on, whatever the order", async () => {
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          {
            id: "total",
            kind: "transform",
            inputs: ["sales"],
            code: "return { sum: data.sales.reduce((t, r) => t + r.amount, 0) };",
          },
          inline("sales", [{ amount: 10 }, { amount: 32 }]),
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.total).toEqual({
      status: "ok",
      rows: [{ sum: 42 }],
      truncated: false,
    });
  });

  test("a transform reads page state, and only declared variables reach it", async () => {
    const { datasets } = await runPageData({
      definition: page(
        [{ key: "floor", type: "number", initial: 0 }],
        [
          inline("sales", [{ amount: 10 }, { amount: 32 }]),
          {
            id: "kept",
            kind: "transform",
            inputs: ["sales"],
            code: "return data.sales.filter(r => r.amount > state.floor);",
          },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: { floor: 20, secret: "ignored" },
    });
    expect(datasets.kept).toEqual({
      status: "ok",
      rows: [{ amount: 32 }],
      truncated: false,
    });
  });

  test("mutually dependent datasets are reported, not looped over", async () => {
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          { id: "a", kind: "transform", inputs: ["b"], code: "return data.b;" },
          { id: "b", kind: "transform", inputs: ["a"], code: "return data.a;" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    // The message has to name the stuck datasets: an agent that only reads
    // "there is a cycle" has to re-derive which ones from the definition.
    expect(datasets.a?.status).toBe("error");
    expect(datasets.b?.status).toBe("error");
    const message =
      datasets.a?.status === "error" ? datasets.a.message : undefined;
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
    expect(message).toContain("cycle");
  });

  test("an input no dataset declares resolves to null rather than stalling the page", async () => {
    // Deliberate: the executor does not stall on a dangling input, and the
    // cycle branch never sees one. `sanitize` is what reports it, by name, at
    // write time — this pins which layer owns the message.
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          {
            id: "derived",
            kind: "transform",
            inputs: ["nowhere"],
            code: "return [{ seen: data.nowhere === null }];",
          },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.derived).toEqual({
      status: "ok",
      rows: [{ seen: true }],
      truncated: false,
    });
  });

  test("one failing dataset costs its own block, not the page", async () => {
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline("good", [{ ok: true }]),
          { id: "bad", kind: "transform", code: "return (;" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.good?.status).toBe("ok");
    expect(datasets.bad?.status).toBe("error");
  });

  test("a targeted refetch withholds other outputs but still feeds dependents", async () => {
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline("sales", [{ amount: 10 }]),
          {
            id: "total",
            kind: "transform",
            inputs: ["sales"],
            code: "return { sum: data.sales.reduce((t, r) => t + r.amount, 0) };",
          },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
      datasetIds: ["total"],
    });
    expect(Object.keys(datasets)).toEqual(["total"]);
    expect(datasets.total).toEqual({
      status: "ok",
      rows: [{ sum: 10 }],
      truncated: false,
    });
  });

  test("a targeted refetch runs the inputs it needs and NOTHING else", async () => {
    // The regression this pins: `datasetIds` used to filter the OUTPUT while
    // still executing every dataset, so re-sorting one table re-ran every query
    // on the page. The closure is what makes it targeted.
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = [];
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline("sales", [{ amount: 10 }]),
          {
            id: "total",
            kind: "transform",
            inputs: ["sales"],
            code: "return { sum: data.sales.reduce((t, r) => t + r.amount, 0) };",
          },
          { id: "untouched", kind: "objects", objectTypeId: "type-1" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
      datasetIds: ["total"],
    });
    expect(Object.keys(datasets)).toEqual(["total"]);
    // `sales` still ran — a transform is worthless without its inputs.
    expect(datasets.total).toEqual({
      status: "ok",
      rows: [{ sum: 10 }],
      truncated: false,
    });
    // `untouched` did not: no query left for a dataset nobody asked for.
    expect(listCalls).toHaveLength(0);
  });

  test("independent datasets run together, not one after the other", async () => {
    // A dashboard's widgets are independent by construction, so running them in
    // series made its latency the SUM of its queries. Overlap is the proof:
    // with a barrier between them, two 40 ms datasets take 80 ms.
    listResult = { count: 0, data: [] };
    fieldDefinitions = [];
    let inFlight = 0;
    let peak = 0;
    listCalls.length = 0;
    const slow = mock(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(40);
      inFlight -= 1;
      return listResult;
    });
    void mock.module("../../src/services/object-records/retrieve", () => ({
      listObjectRecords: slow,
    }));
    const { runPageData: runFresh } =
      await import("../../src/services/pages/run-page-data");

    const startedAt = performance.now();
    await runFresh({
      definition: page(
        [],
        [
          { id: "a", kind: "objects", objectTypeId: "type-1" },
          { id: "b", kind: "objects", objectTypeId: "type-1" },
          { id: "c", kind: "objects", objectTypeId: "type-1" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    const elapsed = performance.now() - startedAt;

    expect(peak).toBe(3);
    expect(elapsed).toBeLessThan(120);

    // Restore the recording mock for the tests that follow.
    void mock.module("../../src/services/object-records/retrieve", () => ({
      listObjectRecords: (params: Record<string, unknown>) => {
        listCalls.push(params);
        return Promise.resolve(listResult);
      },
    }));
  });

  test("a transform that forgets to return fails by name, not by silence", async () => {
    // The single most likely mistake in a body-of-a-function contract. An empty
    // dataset would read exactly like "the query found nothing".
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline("sales", [{ amount: 10 }]),
          {
            id: "js",
            kind: "transform",
            inputs: ["sales"],
            code: "data.sales.map(r => r.amount)",
          },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.js?.status).toBe("error");
    expect(
      datasets.js?.status === "error" ? datasets.js.message : "",
    ).toContain("returned nothing JSON can carry");
  });
});

describe("objectsSource — the stored definition owns the query", () => {
  test("a filter bound to state carries the viewer's value into the query", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await objectsSource.resolve(
      {
        id: "records",
        kind: "objects",
        objectTypeId: "type-1",
        filters: [{ key: "status", op: "eq", value: { var: "status" } }],
      },
      { teamId: "team-1", userId: null, state: { status: "won" }, data: {} },
    );
    expect(listCalls[0]?.filters).toEqual([
      { key: "status", op: "eq", value: "won" },
    ]);
  });

  test('the "All" option — an empty value — drops its filter entirely', async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await objectsSource.resolve(
      {
        id: "records",
        kind: "objects",
        objectTypeId: "type-1",
        filters: [{ key: "status", op: "eq", value: { var: "status" } }],
      },
      { teamId: "team-1", userId: null, state: { status: "" }, data: {} },
    );
    expect(listCalls[0]?.filters).toEqual([]);
  });

  test("the row limit is capped at the page ceiling, whatever the definition asks", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await objectsSource.resolve(
      {
        id: "records",
        kind: "objects",
        objectTypeId: "type-1",
        limit: 999_999,
      },
      { teamId: "team-1", userId: null, state: {}, data: {} },
    );
    expect(listCalls[0]?.limit).toBe(PAGE_LIMITS.maxRows);
  });

  test("an object type the team cannot see degrades to forbidden", async () => {
    const result = await objectsSource.resolve(
      { id: "records", kind: "objects", objectTypeId: "type-unknown" },
      { teamId: "team-1", userId: null, state: {}, data: {} },
    );
    expect(result.status).toBe("forbidden");
  });

  test("truncation is reported when the query had more rows than it returned", async () => {
    listResult = { count: 500, data: [{ id: "r1", label: "R1", data: {} }] };
    const result = await objectsSource.resolve(
      { id: "records", kind: "objects", objectTypeId: "type-1" },
      { teamId: "team-1", userId: null, state: {}, data: {} },
    );
    expect(result.status === "ok" && result.truncated).toBe(true);
  });
});

/**
 * The runtime query — the half a viewer controls.
 *
 * It is bounded on purpose to a WINDOW and an ORDER. Everything that decides
 * WHICH rows exist (object type, filters, operators) stays in the stored
 * definition, which is what lets the same executor serve an anonymous page. The
 * tests below pin both halves: what the query may move, and what it may not.
 */
describe("objectsSource — the window and ordering a viewer may ask for", () => {
  const dataset: PageDataset = {
    id: "records",
    kind: "objects",
    objectTypeId: "type-1",
    limit: 25,
  };
  const sortableFields = [
    { key: "montant", label: "Montant", type: "number", config: {} },
    { key: "client", label: "Client", type: "relation", config: {} },
  ];

  test("a runtime page turns into an offset, 1-based for the viewer", async () => {
    listCalls.length = 0;
    listResult = { count: 3_214_987, data: [] };
    fieldDefinitions = sortableFields;
    const result = await objectsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
      data: {},
      query: { page: 4, pageSize: 50 },
    });
    // The service is 0-based; the wire is 1-based, because that is what a
    // paginator shows.
    expect(listCalls[0]?.page).toBe(3);
    expect(listCalls[0]?.limit).toBe(50);
    expect(result.status === "ok" && result.page).toBe(4);
    expect(result.status === "ok" && result.pageSize).toBe(50);
    expect(result.status === "ok" && result.totalCount).toBe(3_214_987);
  });

  test("the offset ceiling clamps the page, and the answer says so", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    const result = await objectsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
      data: {},
      query: { page: 1000, pageSize: 200 },
    });
    // `page × pageSize` is what Postgres skips row by row, so the product is
    // what has to be bounded — not either factor alone.
    const maxPage = PAGE_LIMITS.maxOffset / 200;
    expect(listCalls[0]?.page).toBe(maxPage);
    // Echoing the CLAMPED page is the point: a paginator drawn from the request
    // would show a page the viewer is not on.
    expect(result.status === "ok" && result.page).toBe(maxPage + 1);
  });

  test("a runtime sort on a real field overrides the author's default", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    await objectsSource.resolve(
      { ...dataset, sortBy: "montant", sortDir: "desc" },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        data: {},
        query: { sortBy: "montant", sortDir: "asc" },
      },
    );
    expect(listCalls[0]?.sortBy).toBe("field:montant");
    expect(listCalls[0]?.sortDir).toBe("asc");
  });

  test("label and the timestamps sort on the registry, not on a field", async () => {
    // These were unreachable: every key was prefixed with `field:`, so asking
    // for `label` looked for a FIELD called label and silently fell back.
    for (const key of ["label", "createdAt", "updatedAt"]) {
      listCalls.length = 0;
      listResult = { count: 0, data: [] };
      fieldDefinitions = sortableFields;
      await objectsSource.resolve(dataset, {
        teamId: "team-1",
        userId: null,
        state: {},
        data: {},
        query: { sortBy: key },
      });
      expect(listCalls[0]?.sortBy).toBe(key);
    }
  });

  test("a sort key the type does not have is dropped, never passed through", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    const result = await objectsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
      data: {},
      query: { sortBy: "montant; DROP TABLE object_records" },
    });
    // Dropping it is what keeps a runtime sort safe to accept from a browser:
    // an unknown name never becomes an identifier in a query. Passing it
    // through would compose SQL over a column that does not exist.
    expect(listCalls[0]?.sortBy).toBeUndefined();
    expect(result.status).toBe("ok");
  });

  test("a computed field is not sortable — it has no column to sort", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    const result = await objectsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
      data: {},
      query: { sortBy: "client" },
    });
    expect(listCalls[0]?.sortBy).toBeUndefined();
    // And the renderer is told, so it never offers the header in the first place.
    const client =
      result.status === "ok"
        ? result.fields?.find((field) => field.key === "client")
        : undefined;
    expect(client?.sortable).toBe(false);
  });

  test("a query never reaches the filters — only the definition decides those", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    await objectsSource.resolve(
      { ...dataset, filters: [{ key: "montant", op: "gt", value: 100 }] },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        data: {},
        query: { page: 2, sortBy: "montant" },
      },
    );
    expect(listCalls[0]?.filters).toEqual([
      { key: "montant", op: "gt", value: 100 },
    ]);
  });

  test("an aggregate ignores the window — its grouping IS the query", async () => {
    aggregateCalls.length = 0;
    fieldDefinitions = sortableFields;
    const result = await objectsSource.resolve(
      { ...dataset, mode: "aggregate", groupBy: "montant" },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        data: {},
        query: { page: 7, pageSize: 200 },
      },
    );
    expect(aggregateCalls[0]?.limit).toBe(25);
    expect(result.status === "ok" && result.page).toBeUndefined();
  });
});

describe("PageDataRequestSchema — what a hostile body cannot get through", () => {
  const parse = (body: unknown) => PageDataRequestSchema.safeParse(body);

  test("an out-of-range page or size is rejected at the boundary", () => {
    for (const query of [
      { page: 1e9 },
      { page: 0 },
      { page: 1.5 },
      { pageSize: 100_000 },
      { pageSize: 0 },
    ]) {
      expect(parse({ variables: {}, queries: { t: query } }).success).toBe(
        false,
      );
    }
  });

  test("a dataset id that is not a page key is rejected", () => {
    // Keys are read back inside expressions (`data.sales`), so the grammar is
    // narrow on purpose — and it is the same grammar here.
    expect(
      parse({ variables: {}, queries: { "t; DROP TABLE pages": { page: 1 } } })
        .success,
    ).toBe(false);
    expect(parse({ variables: {}, datasetIds: ["a-b"] }).success).toBe(false);
  });

  test("a sort key is accepted as TEXT and resolved later, never as SQL", () => {
    // The schema deliberately does not police the name: the source resolves it
    // against the type's real fields and drops what it does not know. Pinning
    // it here would put the ontology's rules in two places.
    const parsed = parse({
      variables: {},
      queries: { t: { sortBy: "'; DROP TABLE object_records --" } },
    });
    expect(parsed.success).toBe(true);
  });

  test("no filter, object type or limit can be smuggled in beside them", () => {
    const parsed = parse({
      variables: {},
      queries: {
        t: {
          page: 1,
          objectTypeId: "type-evil",
          filters: [{ key: "amount", op: "gt", value: 0 }],
        },
      },
    });
    expect(parsed.success && parsed.data.queries?.t).toEqual({ page: 1 });
  });

  test("a window past the offset ceiling still parses — the source clamps it", () => {
    // Bounding each factor is not enough: 1000 × 200 is 200 000 rows to skip.
    // The schema bounds the factors, the source bounds the product.
    const parsed = parse({
      variables: {},
      queries: { t: { page: 1000, pageSize: 200 } },
    });
    expect(parsed.success).toBe(true);
    expect(PAGE_LIMITS.maxPageIndex * PAGE_LIMITS.maxPageSize).toBeGreaterThan(
      PAGE_LIMITS.maxOffset,
    );
  });
});

describe("buildPageFieldDescriptors — the public-safe allowlist", () => {
  test("copies what a badge needs and nothing the field also stores", async () => {
    fieldDefinitions = [
      {
        key: "status",
        label: "Status",
        type: "select",
        isTitle: false,
        config: {
          options: [
            { value: "won", label: "Won", color: "green", icon: "check" },
            { value: "lost" },
          ],
          // None of these may reach an anonymous page.
          rollupFormula: "SUM(deals.amount)",
          internalFieldId: "fld_secret",
          targetTypeKey: "company",
        },
      },
    ];
    const [descriptor] = await buildPageFieldDescriptors({
      teamId: "team-1",
      objectTypeId: "type-1",
    });

    expect(descriptor?.key).toBe("status");
    expect(descriptor?.options).toEqual([
      { value: "won", label: "Won", color: "green", icon: "i-lucide-check" },
      { value: "lost", label: "lost", color: undefined, icon: undefined },
    ]);
    expect(Object.keys(descriptor ?? {})).not.toContain("rollupFormula");
    expect(Object.keys(descriptor ?? {})).not.toContain("internalFieldId");
    expect(JSON.stringify(descriptor)).not.toContain("fld_secret");
  });

  test("every icon leaves in one ready-to-use shape, whatever was stored", async () => {
    // The stored shapes are mixed — the icon picker writes `i-lucide-check`,
    // an object type keeps a bare `building-2` — and a page cannot tell them
    // apart. Whatever it assumed was wrong half the time: the page that wrapped
    // an already-prefixed name asked for `i-lucide-i-lucide-check` and rendered
    // a blank square after three CDN round-trips the sandbox blocks anyway.
    fieldDefinitions = [
      {
        key: "stage",
        label: "Stage",
        type: "select",
        isTitle: false,
        config: {
          options: [
            { value: "bare", label: "Bare", icon: "circle-dashed" },
            { value: "prefixed", label: "Prefixed", icon: "i-lucide-check" },
            { value: "collection", label: "Collection", icon: "lucide:zap" },
          ],
        },
      },
    ];
    const [descriptor] = await buildPageFieldDescriptors({
      teamId: "team-1",
      objectTypeId: "type-1",
    });

    expect(descriptor?.options?.map((option) => option.icon)).toEqual([
      "i-lucide-circle-dashed",
      "i-lucide-check",
      "lucide:zap",
    ]);
  });

  test("an option with no value is dropped rather than shipped half-formed", async () => {
    fieldDefinitions = [
      {
        key: "stage",
        label: "Stage",
        type: "select",
        isTitle: false,
        config: { options: [{ label: "No value here" }, { value: "ok" }] },
      },
    ];
    const [descriptor] = await buildPageFieldDescriptors({
      teamId: "team-1",
      objectTypeId: "type-1",
    });
    expect(descriptor?.options).toEqual([
      { value: "ok", label: "ok", color: undefined, icon: undefined },
    ]);
  });

  test("a team with no fields ships no descriptors", async () => {
    fieldDefinitions = [];
    expect(
      await buildPageFieldDescriptors({
        teamId: "team-1",
        objectTypeId: "type-1",
      }),
    ).toEqual([]);
  });
});
