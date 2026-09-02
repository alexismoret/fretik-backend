import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()`; in a service that happens at boot.
import "@hono/zod-openapi";
import { PageOperationSchema } from "../../src/schemas/pages";

/**
 * What a page operation is refused for BEFORE it is ever stored.
 *
 * Pure Zod, no collaborators: the parse either accepts the object or it does
 * not. The write path these operations feed is exercised against a real
 * database in `tests/integration/pages/record-writes.test.ts` — this file
 * covers the half that never reaches one.
 */

const TYPE = "01a00000-0000-7000-8000-000000000001";

describe("what the schema refuses before a page is even saved", () => {
  test("an operation written before `kind` existed still parses as an app call", () => {
    // The discriminated union picks its arm BEFORE any `.default()` would run,
    // so the fallback has to be a preprocess — otherwise every stored page with
    // an operation would fail to parse and take the whole definition down.
    const parsed = PageOperationSchema.parse({
      id: "ship",
      providerKey: "acme-orders",
      action: "mark_shipped",
    });
    expect(parsed.kind).toBe("app");
  });

  test("an app operation with no connection at all is refused at write time", () => {
    // It used to validate, save, warn about nothing, and only fail when a user
    // clicked it — the silent authoring trap this closes.
    const result = PageOperationSchema.safeParse({
      kind: "app",
      id: "ship",
      action: "mark_shipped",
    });
    expect(result.success).toBe(false);
  });

  test("an update with no recordId is refused — there is no row to write", () => {
    const result = PageOperationSchema.safeParse({
      kind: "record",
      id: "set_status",
      collectionId: TYPE,
      mode: "update",
      args: { status: "done" },
    });
    expect(result.success).toBe(false);
  });

  test("deleting records without a confirm step is refused", () => {
    for (const kind of ["record", "bulk"] as const) {
      const result = PageOperationSchema.safeParse({
        kind,
        id: "remove",
        collectionId: TYPE,
        mode: "delete",
        ...(kind === "bulk"
          ? { recordIds: ["rec-mine"] }
          : { recordId: "rec-mine" }),
      });
      expect(`${kind}: ${result.success.toString()}`).toBe(`${kind}: false`);
    }
  });

  test("bulk has no create — a selection cannot precede the rows it selects", () => {
    const result = PageOperationSchema.safeParse({
      kind: "bulk",
      id: "add_many",
      collectionId: TYPE,
      mode: "create",
      recordIds: [],
    });
    expect(result.success).toBe(false);
  });
});
