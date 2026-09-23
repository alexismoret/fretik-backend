import { describe, expect, test } from "bun:test";
import type { ActionIncremental } from "../../src/external-apps/manifest-schema";
import type { SyncArgs } from "../../src/schemas/collection-sync";
import { syncArgsSincePlacement } from "../../src/schemas/collection-sync";
import { assertSinceBinding } from "../../src/services/collection-sync/assert-since-binding";

/**
 * `{"$since": true}` is the one argument whose misuse is SILENT.
 *
 * Bound to the wrong parameter it is not rejected by the app — it is a filter
 * the app does not know, so it answers with everything. And `syncArgsBindSince`
 * asks only "is one present anywhere", so the run still calls itself
 * incremental and skips the orphan diff. The source then reads the whole table
 * every run AND stops noticing deleted rows, reporting `success` throughout.
 *
 * Which is why the binding is checked once, where a person is present. These
 * cases are the refusals; the shape is Shiptify's real declaration.
 */

const SHIPTIFY: ActionIncremental = {
  param: "created_date_from",
  format: "date",
};

const since = { $since: true } as const;

describe("syncArgsSincePlacement", () => {
  test("names the top-level keys that carry a binding", () => {
    const args: SyncArgs = { created_date_from: since, limit: 100 };
    expect(syncArgsSincePlacement(args)).toEqual({
      topLevel: ["created_date_from"],
      nested: false,
    });
  });

  test("a binding inside an object is nested, not top-level", () => {
    const args: SyncArgs = { filter: { updated: since } };
    expect(syncArgsSincePlacement(args)).toEqual({
      topLevel: [],
      nested: true,
    });
  });

  test("a binding inside an array is nested too", () => {
    const args: SyncArgs = { filters: [since] };
    expect(syncArgsSincePlacement(args)).toEqual({
      topLevel: [],
      nested: true,
    });
  });

  test("arguments with no binding report neither", () => {
    const args: SyncArgs = { limit: 100, status: "open" };
    expect(syncArgsSincePlacement(args)).toEqual({
      topLevel: [],
      nested: false,
    });
  });
});

describe("assertSinceBinding", () => {
  test("accepts the binding on the parameter the action declares", () => {
    expect(() =>
      assertSinceBinding({ created_date_from: since }, SHIPTIFY),
    ).not.toThrow();
  });

  test("accepts arguments that bind nothing, whatever the action declares", () => {
    expect(() => assertSinceBinding({ limit: 100 }, SHIPTIFY)).not.toThrow();
    expect(() => assertSinceBinding({ limit: 100 }, undefined)).not.toThrow();
  });

  test("refuses a binding on an action that declares no incremental parameter", () => {
    expect(() =>
      assertSinceBinding({ created_date_from: since }, undefined),
    ).toThrow(/no incremental parameter/);
  });

  // THE REGRESSION. This is the case that shipped: the binding exists, so the
  // run skips the orphan diff, and it sits on a parameter the app ignores.
  test("refuses a binding on the wrong parameter, and names the right one", () => {
    expect(() =>
      assertSinceBinding({ updated_after: since }, SHIPTIFY),
    ).toThrow(/created_date_from/);
  });

  test("refuses a binding nested inside another value", () => {
    expect(() =>
      assertSinceBinding({ filter: { created_date_from: since } }, SHIPTIFY),
    ).toThrow(/top-level/);
  });

  test("refuses two bindings, even when one of them is right", () => {
    expect(() =>
      assertSinceBinding(
        { created_date_from: since, updated_after: since },
        SHIPTIFY,
      ),
    ).toThrow(/Only one argument/);
  });
});
