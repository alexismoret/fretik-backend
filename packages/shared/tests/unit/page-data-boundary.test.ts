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
 * Collection, filter keys and operators all come from the stored definition,
 * so a forged body cannot widen a page's reach.
 *
 * The db and the two record services are mocked at module level — the dynamic
 * imports below resolve AFTER, and let the tests read back exactly which
 * filters and limits reached the query layer.
 */

/** Collection ids the mocked db "knows"; anything else resolves forbidden. */
const knownCollections = new Set<string>(["type-1"]);
/** Field definitions the mocked team owns, per collection. */
let fieldDefinitions: unknown[] = [];
/** Every call the objects source made into the record services. */
const listCalls: Record<string, unknown>[] = [];
const aggregateCalls: Record<string, unknown>[] = [];
let listResult: { count: number; data: unknown[] } = { count: 0, data: [] };

void mock.module("../../src/db", () => ({
  default: {
    query: {
      collections: {
        findFirst: (args: { where?: { id?: string } }) =>
          Promise.resolve(
            args.where?.id !== undefined && knownCollections.has(args.where.id)
              ? { id: args.where.id }
              : undefined,
          ),
        findMany: () => Promise.resolve([]),
      },
    },
  },
}));

void mock.module("../../src/services/collection-records/retrieve", () => ({
  listCollectionRecords: (params: Record<string, unknown>) => {
    listCalls.push(params);
    return Promise.resolve(listResult);
  },
}));

void mock.module("../../src/services/collection-records/aggregate", () => ({
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
const { collectionsSource } =
  await import("../../src/services/pages/sources/collections");

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
      collectionId: "type-evil",
      filters: [{ key: "amount", op: "gt", value: 0 }],
      teamId: "another-team",
      userId: null,
    });
    expect(state).toEqual({});
  });

  test("declared variables survive; undeclared ones are dropped alongside", () => {
    const state = resolvePageState(
      page([{ key: "status", type: "string", initial: "open" }]),
      { status: "won", collectionId: "type-evil" },
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
    void mock.module("../../src/services/collection-records/retrieve", () => ({
      listCollectionRecords: slow,
    }));
    const { runPageData: runFresh } =
      await import("../../src/services/pages/run-page-data");

    const startedAt = performance.now();
    await runFresh({
      definition: page(
        [],
        [
          { id: "a", kind: "collections", collectionId: "type-1" },
          { id: "b", kind: "collections", collectionId: "type-1" },
          { id: "c", kind: "collections", collectionId: "type-1" },
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
    void mock.module("../../src/services/collection-records/retrieve", () => ({
      listCollectionRecords: (params: Record<string, unknown>) => {
        listCalls.push(params);
        return Promise.resolve(listResult);
      },
    }));
  });
});

describe("collectionsSource — the stored definition owns the query", () => {
  test("a filter bound to state carries the viewer's value into the query", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await collectionsSource.resolve(
      {
        id: "records",
        kind: "collections",
        collectionId: "type-1",
        filters: [{ key: "status", op: "eq", value: { var: "status" } }],
      },
      { teamId: "team-1", userId: null, state: { status: "won" } },
    );
    expect(listCalls[0]?.filters).toEqual([
      { key: "status", op: "eq", value: "won" },
    ]);
  });

  test('the "All" option — an empty value — drops its filter entirely', async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await collectionsSource.resolve(
      {
        id: "records",
        kind: "collections",
        collectionId: "type-1",
        filters: [{ key: "status", op: "eq", value: { var: "status" } }],
      },
      { teamId: "team-1", userId: null, state: { status: "" } },
    );
    expect(listCalls[0]?.filters).toEqual([]);
  });

  test("the row limit is capped at the page ceiling, whatever the definition asks", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    await collectionsSource.resolve(
      {
        id: "records",
        kind: "collections",
        collectionId: "type-1",
        limit: 999_999,
      },
      { teamId: "team-1", userId: null, state: {} },
    );
    expect(listCalls[0]?.limit).toBe(PAGE_LIMITS.maxRows);
  });

  test("a collection the team cannot see degrades to forbidden", async () => {
    const result = await collectionsSource.resolve(
      { id: "records", kind: "collections", collectionId: "type-unknown" },
      { teamId: "team-1", userId: null, state: {} },
    );
    expect(result.status).toBe("forbidden");
  });

  test("one failing dataset costs its own block, not the page", async () => {
    // Degradation is per WIDGET. A source that throws must come back as its own
    // error result so the rest of the page still renders — the alternative is
    // one bad query blanking a screen someone opens every morning.
    listResult = { count: 0, data: [] };
    fieldDefinitions = [];
    void mock.module("../../src/services/collection-records/retrieve", () => ({
      listCollectionRecords: () => {
        throw new Error("boom");
      },
    }));
    const { runPageData: runFresh } =
      await import("../../src/services/pages/run-page-data");
    const { datasets } = await runFresh({
      definition: page(
        [],
        [
          inline("sales", [{ amount: 10 }]),
          { id: "broken", kind: "collections", collectionId: "type-1" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.broken?.status).toBe("error");
    expect(datasets.sales?.status).toBe("ok");

    void mock.module("../../src/services/collection-records/retrieve", () => ({
      listCollectionRecords: (params: Record<string, unknown>) => {
        listCalls.push(params);
        return Promise.resolve(listResult);
      },
    }));
  });

  test("a targeted refetch runs exactly what was asked for and nothing else", async () => {
    // The regression this pins: `datasetIds` used to filter the OUTPUT while
    // still executing every dataset, so re-sorting one table re-ran every query
    // on the page. Since `transform` was retired no dataset reads another, so
    // "exactly its own set" is now the whole rule — there is no closure left.
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = [];
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline("sales", [{ amount: 10 }]),
          { id: "untouched", kind: "collections", collectionId: "type-1" },
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
      datasetIds: ["sales"],
    });
    expect(Object.keys(datasets)).toEqual(["sales"]);
    expect(listCalls).toHaveLength(0);
  });

  test("a dataset whose rows outgrow the byte ceiling is truncated, not refused", async () => {
    // Every other bound counts ROWS, and a row has no size — a legal row count
    // over a type with a long text field serializes to megabytes. The retired
    // transform sandbox capped its own output at 1 MB and was the only thing in
    // the path measuring bytes at all.
    const big = "x".repeat(20_000);
    const { datasets } = await runPageData({
      definition: page(
        [],
        [
          inline(
            "heavy",
            Array.from({ length: 200 }, (_, i) => ({ id: i, body: big })),
          ),
        ],
      ),
      teamId: "team-1",
      userId: null,
      variables: {},
    });
    expect(datasets.heavy?.status).toBe("ok");
    if (datasets.heavy?.status !== "ok") return;
    expect(datasets.heavy.truncated).toBe(true);
    expect(datasets.heavy.rows.length).toBeLessThan(200);
    expect(JSON.stringify(datasets.heavy.rows).length).toBeLessThanOrEqual(
      PAGE_LIMITS.maxDatasetResponseBytes,
    );
  });

  test("truncation is reported when the query had more rows than it returned", async () => {
    listResult = { count: 500, data: [{ id: "r1", label: "R1", data: {} }] };
    const result = await collectionsSource.resolve(
      { id: "records", kind: "collections", collectionId: "type-1" },
      { teamId: "team-1", userId: null, state: {} },
    );
    expect(result.status === "ok" && result.truncated).toBe(true);
  });
});

/**
 * The runtime query — the half a viewer controls.
 *
 * It is bounded on purpose to a WINDOW and an ORDER. Everything that decides
 * WHICH rows exist (collection, filters, operators) stays in the stored
 * definition, which is what lets the same executor serve an anonymous page. The
 * tests below pin both halves: what the query may move, and what it may not.
 */
describe("collectionsSource — the window and ordering a viewer may ask for", () => {
  const dataset: PageDataset = {
    id: "records",
    kind: "collections",
    collectionId: "type-1",
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
    const result = await collectionsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
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
    const result = await collectionsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
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
    await collectionsSource.resolve(
      { ...dataset, sortBy: "montant", sortDir: "desc" },
      {
        teamId: "team-1",
        userId: null,
        state: {},
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
      await collectionsSource.resolve(dataset, {
        teamId: "team-1",
        userId: null,
        state: {},
        query: { sortBy: key },
      });
      expect(listCalls[0]?.sortBy).toBe(key);
    }
  });

  test("a sort key the type does not have is dropped, never passed through", async () => {
    listCalls.length = 0;
    listResult = { count: 0, data: [] };
    fieldDefinitions = sortableFields;
    const result = await collectionsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
      query: { sortBy: "montant; DROP TABLE collection_records" },
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
    const result = await collectionsSource.resolve(dataset, {
      teamId: "team-1",
      userId: null,
      state: {},
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
    await collectionsSource.resolve(
      { ...dataset, filters: [{ key: "montant", op: "gt", value: 100 }] },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        query: { page: 2, sortBy: "montant" },
      },
    );
    expect(listCalls[0]?.filters).toEqual([
      { key: "montant", op: "gt", value: 100 },
    ]);
  });

  test("an aggregate has no offset to walk, so `page` means nothing to it", async () => {
    aggregateCalls.length = 0;
    fieldDefinitions = sortableFields;
    const result = await collectionsSource.resolve(
      { ...dataset, mode: "aggregate", groupBy: "montant" },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        query: { page: 7 },
      },
    );
    expect(aggregateCalls[0]?.limit).toBe(25);
    expect(result.status === "ok" && result.page).toBeUndefined();
  });

  test("`pageSize` on an aggregate is how many GROUPS — top 10 becomes top 20", async () => {
    // Narrowed on 2026-08-21 from "an aggregate ignores the window": `page`
    // still means nothing, but the group COUNT is the one thing a viewer may
    // legitimately want to change at runtime and had no other way to say.
    // `limit` is not variable-bindable, so without this a chart is stuck at
    // whatever its author guessed.
    aggregateCalls.length = 0;
    fieldDefinitions = sortableFields;
    await collectionsSource.resolve(
      { ...dataset, mode: "aggregate", groupBy: "montant" },
      {
        teamId: "team-1",
        userId: null,
        state: {},
        query: { pageSize: 60 },
      },
    );
    expect(aggregateCalls[0]?.limit).toBe(60);
  });

  test("an aggregate sorts by a metric NAME, and refuses one it never declared", async () => {
    // `resolveSortKey` validates against the type's fields and would reject
    // every one of an aggregate's own columns, which is why the branch used to
    // drop `query` whole. An unknown name still falls back to the author's
    // order rather than reaching an ORDER BY.
    aggregateCalls.length = 0;
    fieldDefinitions = sortableFields;
    const aggregate = {
      ...dataset,
      mode: "aggregate" as const,
      groupBy: "montant",
      sortBy: "group",
      metrics: [{ name: "total", fn: "sum" as const, key: "montant" }],
    };
    await collectionsSource.resolve(aggregate, {
      teamId: "team-1",
      userId: null,
      state: {},
      query: { sortBy: "total", sortDir: "asc" },
    });
    expect(aggregateCalls[0]?.sortBy).toBe("total");
    expect(aggregateCalls[0]?.sortDir).toBe("asc");

    aggregateCalls.length = 0;
    await collectionsSource.resolve(aggregate, {
      teamId: "team-1",
      userId: null,
      state: {},
      query: { sortBy: "montant" },
    });
    expect(aggregateCalls[0]?.sortBy).toBe("group");
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
      queries: { t: { sortBy: "'; DROP TABLE collection_records --" } },
    });
    expect(parsed.success).toBe(true);
  });

  test("no filter, collection or limit can be smuggled in beside them", () => {
    const parsed = parse({
      variables: {},
      queries: {
        t: {
          page: 1,
          collectionId: "type-evil",
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
          targetCollectionKey: "company",
        },
      },
    ];
    const [descriptor] = await buildPageFieldDescriptors({
      teamId: "team-1",
      collectionId: "type-1",
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
    // a collection keeps a bare `building-2` — and a page cannot tell them
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
      collectionId: "type-1",
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
      collectionId: "type-1",
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
        collectionId: "type-1",
      }),
    ).toEqual([]);
  });
});
