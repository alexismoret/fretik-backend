import { afterEach, describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it is imported for the effect.
import "@hono/zod-openapi";
import type { PageDataset } from "../../src/schemas/pages";
import {
  externalSource,
  inferExternalFields,
  registerExternalPageQueryExecutor,
  resetExternalPageQueryExecutor,
  resolveExternalArgs,
  type ExternalPageQueryExecutor,
} from "../../src/services/pages/sources/external";

/**
 * The external SEAM: what reaches a registered executor, and what a page gets
 * back. The executor here is a fake — the real one (`exec/page-query.ts`)
 * talks to connections and Redis, which is not this file's business. What IS
 * this file's business: the refusal default, the `{ var }` resolution that
 * happens BEFORE the executor (declared state only, drop-on-empty), and the
 * result mapping the frontend depends on.
 */

type ExecutorInput = Parameters<ExternalPageQueryExecutor["execute"]>[0];

const dataset = (extra: Partial<PageDataset>): PageDataset => ({
  id: "inbox",
  kind: "external",
  operation: "list_messages",
  providerKey: "acme-mail",
  ...extra,
});

const context = {
  teamId: "team-1",
  userId: "user-1",
  state: {},
  data: {},
} as const;

afterEach(() => {
  resetExternalPageQueryExecutor();
});

describe("externalSource — the seam", () => {
  test("refuses while no executor is registered", async () => {
    const result = await externalSource.resolve(dataset({}), { ...context });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("not enabled");
    }
  });

  test("a dataset without operation or any connection reference fails its own block", async () => {
    registerExternalPageQueryExecutor({
      execute: () =>
        Promise.resolve({ status: "ok", rows: [], truncated: false }),
    });
    const noOperation = await externalSource.resolve(
      dataset({ operation: undefined }),
      { ...context },
    );
    expect(noOperation.status).toBe("error");

    const noConnection = await externalSource.resolve(
      dataset({ providerKey: undefined, connectionId: undefined }),
      { ...context },
    );
    expect(noConnection.status).toBe("error");
  });

  test("everything the definition declares reaches the executor, args resolved", async () => {
    const seen: ExecutorInput[] = [];
    registerExternalPageQueryExecutor({
      execute: (input) => {
        seen.push(input);
        return Promise.resolve({
          status: "ok",
          rows: [{ subject: "hi" }],
          truncated: false,
        });
      },
    });

    const result = await externalSource.resolve(
      dataset({
        args: { folder: { var: "folder" }, limit: 25 },
        resultPath: "value.items",
        cacheTtlSeconds: 120,
      }),
      { ...context, state: { folder: "inbox" }, fresh: true },
    );

    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input?.teamId).toBe("team-1");
    expect(input?.userId).toBe("user-1");
    expect(input?.providerKey).toBe("acme-mail");
    expect(input?.operation).toBe("list_messages");
    // The reference arrived as a LITERAL — the executor never sees `{ var }`.
    expect(input?.args).toEqual({ folder: "inbox", limit: 25 });
    expect(input?.resultPath).toBe("value.items");
    expect(input?.cacheTtlSeconds).toBe(120);
    expect(input?.fresh).toBe(true);
  });

  test("needs_connection and error map through untouched", async () => {
    registerExternalPageQueryExecutor({
      execute: () =>
        Promise.resolve({
          status: "needs_connection",
          providerKey: "acme-mail",
          displayName: "Acme Mail",
        }),
    });
    const needs = await externalSource.resolve(dataset({}), { ...context });
    expect(needs).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
      displayName: "Acme Mail",
    });

    registerExternalPageQueryExecutor({
      execute: () =>
        Promise.resolve({ status: "error", message: "upstream 503" }),
    });
    const failed = await externalSource.resolve(dataset({}), { ...context });
    expect(failed).toEqual({ status: "error", message: "upstream 503" });
  });

  test("a reference to nothing drops its argument — never sends null upstream", async () => {
    const seen: ExecutorInput[] = [];
    registerExternalPageQueryExecutor({
      execute: (input) => {
        seen.push(input);
        return Promise.resolve({ status: "ok", rows: [], truncated: false });
      },
    });
    const result = await externalSource.resolve(
      dataset({ args: { folder: { var: "ghost" }, limit: 10 } }),
      { ...context },
    );
    // A `{ var }` naming no declared variable is data pointing at nothing —
    // the sanitizer warned at write time, and here the key simply drops (the
    // "empty means all" convention filters already follow).
    expect(result.status).toBe("ok");
    expect(seen[0]?.args).toEqual({ limit: 10 });
  });
});

describe("resolveExternalArgs — declared state only", () => {
  test("references resolve against state; unknown names are dropped", () => {
    const resolved = resolveExternalArgs(
      { folder: { var: "folder" }, leak: { var: "secrets" } },
      { folder: "sent" },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // `secrets` is not in the coerced state → the key is dropped, the
      // "empty means all" convention filters already follow.
      expect(resolved.args).toEqual({ folder: "sent" });
    }
  });

  test("references are resolved at any depth, and empty entries drop", () => {
    const resolved = resolveExternalArgs(
      {
        query: {
          folders: [{ var: "a" }, { var: "missing" }, "fixed"],
          flag: true,
        },
      },
      { a: "inbox" },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.args).toEqual({
        query: { folders: ["inbox", "fixed"], flag: true },
      });
    }
  });
});

/**
 * The display dictionary an external dataset never shipped.
 *
 * An `objects` dataset comes back with `fields`, and that descriptor is what
 * turns a column into a labelled, formatted value. External datasets shipped
 * rows alone, which is the structural reason every page over a connected app
 * shows the provider's own key — `givenName`, `dateTimeCreated` — to a person.
 */
describe("inferred fields for an external dataset", () => {
  test("names the columns the way a person would", () => {
    const fields = inferExternalFields([
      { givenName: "Marion", family_name: "Blay", "job-title": "Analyst" },
    ]);
    expect(fields.map((f) => f.label)).toEqual([
      "Given name",
      "Family name",
      "Job title",
    ]);
  });

  test("claims a type only when every observed value agrees", () => {
    const fields = inferExternalFields([
      { seats: 4, live: true, name: "Board room", mixed: 1 },
      { seats: 12, live: false, name: "Small room", mixed: "many" },
    ]);
    const typeOf = (key: string): string =>
      fields.find((f) => f.key === key)?.type ?? "";
    expect(typeOf("seats")).toBe("number");
    expect(typeOf("live")).toBe("boolean");
    expect(typeOf("name")).toBe("text");
    // A wrong type is worse than none: it routes the value into a formatter it
    // cannot survive. Mixed columns say so instead of guessing.
    expect(typeOf("mixed")).toBe("unknown");
  });

  test("a null says nothing about a type — it must not poison one", () => {
    // A key empty in the first row and a number in the second is a number.
    // Treating the null as its own kind would mark every sparse column mixed.
    const fields = inferExternalFields([{ seats: null }, { seats: 12 }]);
    expect(fields[0]?.type).toBe("number");
  });

  test("tells a timestamp from a calendar day", () => {
    const fields = inferExternalFields([
      { startsAt: "2026-08-21T09:30:00Z", day: "2026-08-21" },
    ]);
    const startsAt = fields.find((f) => f.key === "startsAt");
    const day = fields.find((f) => f.key === "day");
    expect(startsAt?.type).toBe("date");
    expect(startsAt?.hasTime).toBe(true);
    expect(day?.type).toBe("date");
    expect(day?.hasTime).toBeUndefined();
  });

  test("nothing from a third party is sortable or writable", () => {
    // The server holds none of it: there is no column to order by and nothing
    // a `record` operation could write back to.
    for (const field of inferExternalFields([{ a: 1, b: "x" }])) {
      expect(field.sortable).toBe(false);
      expect(field.writable).toBe(false);
    }
  });

  test("a shapeless answer yields no dictionary rather than a wrong one", () => {
    expect(inferExternalFields([])).toEqual([]);
    expect(inferExternalFields(["a", "b"])).toEqual([]);
  });
});
