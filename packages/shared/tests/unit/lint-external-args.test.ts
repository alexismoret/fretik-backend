import { describe, expect, test } from "bun:test";
import type { ManifestAction } from "../../src/external-apps/manifest-schema";
import type { PageDefinition } from "../../src/schemas/pages";
import { mockModule } from "../lib/mock-module";

/**
 * A dataset whose arguments the app will refuse, caught at BUILD.
 *
 * Measured in production 2026-09-14: `"sort": "date"` where the action takes
 * a list. The app rejected every request, the page got no rows, and the only
 * component that could see it was the runtime — hours later, in front of the
 * user. The review then spent four rounds calling the result fabricated data.
 */

const actions: Record<string, ManifestAction> = {};
await mockModule("../../src/external-apps/registry", {
  getAction: (qualifiedName: string) => {
    const action = actions[qualifiedName];
    return action === undefined
      ? undefined
      : { providerKey: qualifiedName.split(".")[0], action };
  },
});

const { lintExternalDatasetArgs } =
  await import("../../src/services/pages/lint/external-args");

actions["pbyp.query_items"] = {
  name: "query_items",
  kind: "read",
  summary: "Read a collection",
  returns: { list: "Row" },
  params: {
    collection: { type: "string" },
    sort: { type: "array", items: { type: "string" }, optional: true },
    limit: { type: "integer", min: -1, max: 200, optional: true },
  },
};

actions["pbyp.create_items"] = {
  name: "create_items",
  kind: "write",
  summary: "Create rows",
  returns: { list: "Row" },
  params: { collection: { type: "string" } },
};

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
