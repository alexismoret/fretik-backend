import { describe, expect, it } from "bun:test";
import type { ParamSpec } from "../../src/external-apps/manifest-schema";
import {
  extractRows,
  resolveActionPagination,
  walkRead,
  type WalkableAction,
} from "../../src/services/collection-sync/walk-read";

/**
 * The walker, against a fake executor.
 *
 * What is being tested is a POLICY, not a transport: how many calls the walker
 * makes, with which arguments, and when it stops. That is why there is no
 * provider and no network anywhere here — the real call is injected, and every
 * assertion is about the argument sequence the fake received, which is the only
 * thing a third party would ever see.
 *
 * The properties that matter, in the order they break:
 *  - `page-number` starts at 1 and `offset` starts at 0. Walking one as the
 *    other either skips the first page or re-reads it forever, which is why
 *    they are separate kinds and not a cast (Pbyp's `query_items`).
 *  - a cursor stops when the token repeats. A provider that echoes its token
 *    would otherwise spin to `maxPagesPerRun`.
 *  - every bound ends the walk CLEANLY with a reason. A run that stops at its
 *    ceiling has still done useful work; throwing would throw that away.
 *  - `{"$since": true}` is DROPPED with no `lastSuccessAt`. Sending it empty is
 *    how a first run seeds nothing.
 */

const param = (spec: Partial<ParamSpec> = {}): ParamSpec => ({
  type: "integer",
  optional: true,
  ...spec,
});

interface Fake {
  action: WalkableAction;
  calls: Record<string, unknown>[];
}

/** An action whose answer is a function of the arguments it was given. */
const fake = (input: {
  params?: Record<string, ParamSpec>;
  answer: (args: Record<string, unknown>, callIndex: number) => unknown;
  pagination?: WalkableAction["pagination"];
  returns?: WalkableAction["returns"];
  incremental?: WalkableAction["incremental"];
  walksItself?: boolean;
}): Fake => {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    action: {
      params: input.params ?? {},
      ...(input.returns !== undefined ? { returns: input.returns } : {}),
      ...(input.pagination !== undefined
        ? { pagination: input.pagination }
        : {}),
      ...(input.incremental !== undefined
        ? { incremental: input.incremental }
        : {}),
      walksItself: input.walksItself ?? false,
      call: (args) => {
        const index = calls.length;
        calls.push(args);
        return Promise.resolve(input.answer(args, index));
      },
    },
  };
};

/** `n` rows numbered from `from`. */
const page = (from: number, n: number): { id: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));

describe("resolveActionPagination — what is inferred when nothing is declared", () => {
  it("prefers the declaration over every inference", () => {
    expect(
      resolveActionPagination({
        pagination: { kind: "offset" },
        returns: { page: "Shipment" },
        walksItself: true,
      }),
    ).toEqual({ kind: "offset" });
  });

  it("treats a server-walked action as already whole", () => {
    expect(resolveActionPagination({ walksItself: true }).kind).toBe("auto");
  });

  it("infers a page_token cursor from a {page} return", () => {
    expect(
      resolveActionPagination({
        returns: { page: "Contact" },
        walksItself: false,
      }),
    ).toEqual({
      kind: "cursor",
      tokenParam: "page_token",
      tokenPath: "page_token",
    });
  });

  it("infers ONE call from anything else, never limit/offset", () => {
    // Plenty of actions take a `limit` and have no second page to give.
    expect(
      resolveActionPagination({
        returns: { list: "Entry" },
        walksItself: false,
      }).kind,
    ).toBe("none");
  });
});

describe("extractRows", () => {
  it("unwraps the declared {items} shape without being told to", () => {
    expect(extractRows({ items: [{ a: 1 }], page_token: "x" })).toEqual([
      { a: 1 },
    ]);
  });

  it("treats a lone object as one row (a get_* for a lookup source)", () => {
    expect(extractRows({ a: 1 })).toEqual([{ a: 1 }]);
  });

  it("wraps scalars so a mapping path always has something to walk", () => {
    expect(extractRows(["a", "b"])).toEqual([{ value: "a" }, { value: "b" }]);
  });

  it("reports a resultPath that found nothing, distinctly from no rows", () => {
    expect(extractRows({ data: [] }, "data")).toEqual([]);
    expect(extractRows({ data: [] }, "nope")).toBeUndefined();
  });
});

describe("walkRead — one call modes", () => {
  it("makes exactly one call for `none`", async () => {
    const f = fake({ answer: () => page(0, 3) });
    const result = await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls).toHaveLength(1);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("makes exactly one call for `auto`, however many rows come back", async () => {
    const f = fake({ walksItself: true, answer: () => page(0, 500) });
    const result = await walkRead({
      action: f.action,
      args: {},
      rowCap: 10_000,
    });
    expect(f.calls).toHaveLength(1);
    expect(result.rows).toHaveLength(500);
  });
});

describe("walkRead — cursor", () => {
  const cursorAction = () =>
    fake({
      params: { page_token: param({ type: "string" }), limit: param() },
      returns: { page: "Row" },
      answer: (_args, i) =>
        i < 2
          ? { items: page(i * 2, 2), page_token: `t${String(i + 1)}` }
          : { items: page(4, 1), page_token: null },
    });

  it("walks until the provider stops handing out a token", async () => {
    const f = cursorAction();
    const result = await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls).toHaveLength(3);
    // The first call carries no token; the next two carry what came back.
    expect(f.calls[0]?.["page_token"]).toBeUndefined();
    expect(f.calls[1]?.["page_token"]).toBe("t1");
    expect(f.calls[2]?.["page_token"]).toBe("t2");
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("stops rather than spinning when a provider echoes its token", async () => {
    const f = fake({
      params: { page_token: param({ type: "string" }) },
      returns: { page: "Row" },
      answer: (args) => ({
        items: page(0, 2),
        page_token: args["page_token"] ?? "same",
      }),
    });
    const result = await walkRead({ action: f.action, args: {}, rowCap: 1000 });
    expect(f.calls).toHaveLength(2);
    expect(result.rows).toHaveLength(4);
  });

  it("says `unpaged` when the declared token param does not exist", async () => {
    const f = fake({
      params: {},
      pagination: { kind: "cursor" },
      answer: () => ({ items: page(0, 2), page_token: "more" }),
    });
    const result = await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls).toHaveLength(1);
    // There WAS another page and no way to ask for it — saying so beats
    // pretending the collection is complete.
    expect(result.truncatedReason).toBe("unpaged");
  });
});

describe("walkRead — offset and page-number are not the same walk", () => {
  it("counts ROWS from zero in offset mode", async () => {
    const f = fake({
      params: { limit: param(), offset: param() },
      pagination: { kind: "offset", maxLimit: 2 },
      answer: (_args, i) => (i < 2 ? page(i * 2, 2) : []),
    });
    await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls.map((c) => c["offset"])).toEqual([0, 2, 4]);
    expect(f.calls[0]?.["limit"]).toBe(2);
  });

  it("counts PAGES from one in page-number mode", async () => {
    // Directus' `page` is 1 for the first page where an offset is 0. Sending 0
    // either re-reads page one forever or skips it — the reason this kind exists.
    const f = fake({
      params: { limit: param(), page: param() },
      pagination: { kind: "page-number", maxLimit: 2 },
      answer: (_args, i) => (i < 2 ? page(i * 2, 2) : []),
    });
    await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls.map((c) => c["page"])).toEqual([1, 2, 3]);
  });

  it("honours a custom parameter name", async () => {
    const f = fake({
      params: { per_page: param(), page_number: param() },
      pagination: {
        kind: "page-number",
        pageParam: "page_number",
        limitParam: "per_page",
        maxLimit: 5,
      },
      answer: () => [],
    });
    await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls[0]).toEqual({ page_number: 1, per_page: 5 });
  });

  it("stops on a short page without asking for one more", async () => {
    const f = fake({
      params: { limit: param(), offset: param() },
      pagination: { kind: "offset", maxLimit: 10 },
      answer: () => page(0, 3),
    });
    const result = await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls).toHaveLength(1);
    expect(result.rows).toHaveLength(3);
  });

  it("takes the page size from the param's own max when nothing declares one", async () => {
    const f = fake({
      params: { limit: param({ max: 7 }), offset: param() },
      pagination: { kind: "offset" },
      answer: () => [],
    });
    await walkRead({ action: f.action, args: {}, rowCap: 100 });
    expect(f.calls[0]?.["limit"]).toBe(7);
  });
});

describe("walkRead — every bound ends the walk cleanly", () => {
  const endless = () =>
    fake({
      params: { limit: param(), offset: param() },
      pagination: { kind: "offset", maxLimit: 10 },
      answer: (args) => page(Number(args["offset"] ?? 0), 10),
    });

  it("stops at rowCap and never returns more than it", async () => {
    const f = endless();
    const result = await walkRead({ action: f.action, args: {}, rowCap: 25 });
    expect(result.rows).toHaveLength(25);
    expect(result.truncatedReason).toBe("row_cap");
  });

  it("asks for only what is left rather than a full last page", async () => {
    const f = endless();
    await walkRead({ action: f.action, args: {}, rowCap: 25 });
    expect(f.calls[2]?.["limit"]).toBe(5);
  });

  it("stops at the page ceiling", async () => {
    const f = endless();
    const result = await walkRead({
      action: f.action,
      args: {},
      rowCap: 10_000,
      maxPages: 3,
    });
    expect(f.calls).toHaveLength(3);
    expect(result.truncatedReason).toBe("page_cap");
    expect(result.calls).toBe(3);
  });

  it("stops at the call ceiling", async () => {
    const f = endless();
    const result = await walkRead({
      action: f.action,
      args: {},
      rowCap: 10_000,
      maxCalls: 2,
    });
    expect(result.truncatedReason).toBe("call_cap");
  });

  it("stops at the deadline, before spending a call it cannot use", async () => {
    const f = endless();
    const result = await walkRead({
      action: f.action,
      args: {},
      rowCap: 10_000,
      deadlineAt: Date.now() - 1,
    });
    // Checked BEFORE the call: an over-budget call is one the third party is
    // charged for and we throw away.
    expect(f.calls).toHaveLength(0);
    expect(result.truncatedReason).toBe("deadline");
  });
});

describe("walkRead — the $since binding", () => {
  const sinceAction = () =>
    fake({
      params: { updated_after: param({ type: "datetime" }) },
      incremental: { param: "updated_after", format: "iso" },
      answer: () => [],
    });

  it("drops the key entirely on a first run", async () => {
    const f = sinceAction();
    await walkRead({
      action: f.action,
      args: { updated_after: { $since: true } },
      rowCap: 10,
    });
    // Not `null`, not `""`: absent. An API handed `updated_after=""` answers
    // anything from "everything" to a 400, and the first run must be full.
    expect(f.calls[0]).toEqual({});
  });

  it("formats lastSuccessAt the way the action declares", async () => {
    const at = new Date("2026-03-04T05:06:07Z");
    const iso = sinceAction();
    await walkRead({
      action: iso.action,
      args: { updated_after: { $since: true } },
      rowCap: 10,
      lastSuccessAt: at,
    });
    expect(iso.calls[0]?.["updated_after"]).toBe("2026-03-04T05:06:07.000Z");

    const dateOnly = fake({
      params: { created_date_from: param({ type: "date" }) },
      incremental: { param: "created_date_from", format: "date" },
      answer: () => [],
    });
    await walkRead({
      action: dateOnly.action,
      args: { created_date_from: { $since: true } },
      rowCap: 10,
      lastSuccessAt: at,
    });
    // A provider that wants a day rejects an instant, and vice-versa.
    expect(dateOnly.calls[0]?.["created_date_from"]).toBe("2026-03-04");

    const epoch = fake({
      params: { since: param() },
      incremental: { param: "since", format: "epoch-seconds" },
      answer: () => [],
    });
    await walkRead({
      action: epoch.action,
      args: { since: { $since: true } },
      rowCap: 10,
      lastSuccessAt: at,
    });
    expect(epoch.calls[0]?.["since"]).toBe(Math.floor(at.getTime() / 1000));
  });

  it("carries literal arguments onto every page", async () => {
    const f = fake({
      params: {
        limit: param(),
        offset: param(),
        status: param({ type: "string" }),
      },
      pagination: { kind: "offset", maxLimit: 2 },
      answer: (_args, i) => (i < 1 ? page(0, 2) : []),
    });
    await walkRead({
      action: f.action,
      args: { status: "delivered" },
      rowCap: 100,
    });
    expect(f.calls.every((c) => c["status"] === "delivered")).toBe(true);
  });
});

describe("walkRead — a resultPath that finds nothing is a configuration error", () => {
  it("throws with the path in the message rather than syncing zero rows", async () => {
    const f = fake({ answer: () => ({ data: [] }) });
    const failure = await walkRead({
      action: f.action,
      args: {},
      rowCap: 10,
      resultPath: "results",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("results");
  });
});
