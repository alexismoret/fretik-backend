import { beforeAll, describe, expect, test } from "bun:test";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { setProviders } from "../../src/external-apps/registry";
import type { PageDefinition } from "../../src/schemas/pages";
import { lintExternalDatasetArgs } from "../../src/services/pages/lint/external-args";

/**
 * A dataset whose arguments the app will refuse, caught at BUILD.
 *
 * Measured in production 2026-09-14: `"sort": "date"` where the action takes
 * a list. The app rejected every request, the page got no rows, and the only
 * component that could see it was the runtime — hours later, in front of the
 * user. The review then spent four rounds calling the result fabricated data.
 *
 * A REGISTERED provider, not a `mock.module` double of `getAction`. The
 * override this file used to install was process-wide: `--isolate` gives each
 * file its own registry for the modules it imports but does NOT contain a
 * `mock.module` registration (see `tests/lib/mock-module.ts`), so a fake
 * `getAction` closing over THIS file's two actions was served to every file
 * that ran after it. The two suites that register their own fixture provider
 * were the ones that paid: `computeLookupHash` stopped seeing
 * `excludeFromHash` and `purgeExecutedPayloads` stopped recognising its own
 * action, both falling back to "unknown action, leave it alone". What the run
 * showed was whichever of the two this file happened to precede — 5 failures
 * when it preceded both, 4 or 1 when it landed between them, 0 when it ran
 * last — which is why it read as flakiness rather than as a bug. The registry
 * merges by provider key, so registering `pbyp` for real costs nobody else in
 * the run anything.
 */

const manifest: ProviderManifest = {
  key: "pbyp",
  displayName: "Lint fixture",
  description: "Synthetic provider exercising external-dataset arg linting.",
  nangoProviderConfigKey: "pbyp",
  icon: "i-lucide-flask-conical",
  transport: { kind: "custom-handler" },
  scopes: [],
  categories: ["storage"],
  types: { Row: { id: { type: "string" } } },
  actions: [
    {
      name: "query_items",
      kind: "read",
      summary: "Read a collection",
      handler: "queryItems",
      returns: { list: "Row" },
      params: {
        collection: { type: "string" },
        sort: { type: "array", items: { type: "string" }, optional: true },
        limit: { type: "integer", min: -1, max: 200, optional: true },
      },
    },
    {
      name: "create_items",
      kind: "write",
      summary: "Create rows",
      handler: "createItems",
      returns: { list: "Row" },
      params: { collection: { type: "string" } },
    },
  ],
};

beforeAll(() => {
  setProviders({
    pbyp: {
      manifest,
      handlers: {
        queryItems: async () => ({}),
        createItems: async () => ({}),
      },
      summaries: {
        create_items: () => ({ titleKey: "default", fields: [] }),
      },
    },
  });
});

const definition = (
  dataset: Record<string, unknown>,
  variables: PageDefinition["variables"] = [],
): PageDefinition =>
  ({
    version: 3,
    variables,
    datasets: [{ id: "orders", kind: "external", ...dataset }],
    operations: [],
    code: { files: {} },
  }) as unknown as PageDefinition;

const messages = (def: PageDefinition): string =>
  lintExternalDatasetArgs(def)
    .map((finding) => finding.message)
    .join(" ");

describe("lintExternalDatasetArgs", () => {
  test("refuses the shape the app refuses, naming the dataset and the param", () => {
    const findings = lintExternalDatasetArgs(
      definition({
        providerKey: "pbyp",
        operation: "query_items",
        args: { collection: "orders", sort: "date" },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.path).toBe("page.json");
    expect(findings[0]?.message).toContain("orders");
    expect(findings[0]?.message).toContain("sort");
  });

  test("says nothing about arguments the app accepts", () => {
    expect(
      lintExternalDatasetArgs(
        definition({
          providerKey: "pbyp",
          operation: "query_items",
          args: { collection: "orders", sort: ["date"], limit: -1 },
        }),
      ),
    ).toEqual([]);
  });

  test("a write is refused — a dataset may only read", () => {
    expect(
      messages(
        definition({
          providerKey: "pbyp",
          operation: "create_items",
          args: { collection: "orders" },
        }),
      ),
    ).toContain("is a write");
  });

  test("an argument bound to a variable validates against its default", () => {
    expect(
      lintExternalDatasetArgs(
        definition(
          {
            providerKey: "pbyp",
            operation: "query_items",
            args: { collection: "orders", limit: { var: "size" } },
          },
          [{ key: "size", type: "number", initial: 50 }],
        ),
      ),
    ).toEqual([]);
  });

  test("an app with no manifest is left alone — a custom MCP key has none", () => {
    expect(
      lintExternalDatasetArgs(
        definition({
          providerKey: "some-mcp-server",
          operation: "whatever",
          args: { nonsense: true },
        }),
      ),
    ).toEqual([]);
  });

  test("a dataset pinned by connection alone needs a database read, so it is skipped", () => {
    expect(
      lintExternalDatasetArgs(
        definition({
          connectionId: "0199a0b0-0000-7000-8000-000000000000",
          operation: "query_items",
          args: { sort: "date" },
        }),
      ),
    ).toEqual([]);
  });

  test("a collections dataset is not this rule's business", () => {
    expect(
      lintExternalDatasetArgs({
        version: 3,
        variables: [],
        datasets: [{ id: "records", kind: "collections", mode: "records" }],
        operations: [],
        code: { files: {} },
      } as unknown as PageDefinition),
    ).toEqual([]);
  });
});
