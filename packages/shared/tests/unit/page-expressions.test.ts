import type { PageEvalScope } from "@fretik/render/runtime/expressions";
import {
  evaluatePageExpression,
  isTruthyPageValue,
  pageExpressionSyntaxError,
} from "@fretik/render/runtime/expressions";
import { describe, expect, test } from "bun:test";

const scope: PageEvalScope = {
  state: { month: "2025-01", currency: "EUR", threshold: 90 },
  data: {
    sales: [
      { customer: "A", amount: 100, month: "2025-01" },
      { customer: "B", amount: 250, month: "2025-01" },
      { customer: "A", amount: 70, month: "2025-02" },
    ],
  },
};

describe("evaluatePageExpression", () => {
  test("reads page state and dataset rows", async () => {
    expect(await evaluatePageExpression("state.month", scope)).toEqual({
      ok: true,
      value: "2025-01",
    });

    expect(
      await evaluatePageExpression("$sum(data.sales.amount)", scope),
    ).toEqual({ ok: true, value: 420 });
  });

  test("reaches page state from inside a predicate through the root", async () => {
    // The documented gotcha: inside `[...]` the context is the row, so a bare
    // `state.month` resolves against the row and yields nothing. The catalog
    // tells the agent to use `$$`.
    expect(
      await evaluatePageExpression(
        "$sum(data.sales[month = $$.state.month].amount)",
        scope,
      ),
    ).toEqual({ ok: true, value: 350 });

    const bare = await evaluatePageExpression(
      "$sum(data.sales[month = state.month].amount)",
      scope,
    );
    expect(bare).toEqual({ ok: true, value: undefined });
  });

  test("groups and aggregates", async () => {
    expect(
      await evaluatePageExpression("data.sales{customer: $sum(amount)}", scope),
    ).toEqual({ ok: true, value: { A: 170, B: 250 } });
  });

  test("exposes the repeat row as item", async () => {
    expect(
      await evaluatePageExpression("item.customer & '/' & $string(index)", {
        ...scope,
        item: { customer: "A", amount: 100 },
        index: 2,
      }),
    ).toEqual({ ok: true, value: "A/2" });
  });

  test("a missing path degrades to undefined, not an error", async () => {
    const result = await evaluatePageExpression("nope.deep.path", scope);
    expect(result.ok).toBe(true);
  });

  test("a syntax error is returned, never thrown", async () => {
    const result = await evaluatePageExpression("this is not ( valid", scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("could not parse");
  });
});

describe("runaway guards", () => {
  test("a long-running expression is stopped by the timeout", async () => {
    const result = await evaluatePageExpression(
      "$map([1..20000], function($x) { $sum([1..2000]) })",
      scope,
      { timeoutMs: 300 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timeout");
  });

  test("runaway recursion is stopped by the stack limit", async () => {
    const result = await evaluatePageExpression(
      "( $f := function($n) { $n <= 0 ? 0 : $f($n - 1) + 1 }; $f(5000) )",
      scope,
      { maxDepth: 50 },
    );
    expect(result.ok).toBe(false);
  });

  test("an oversized sequence is stopped", async () => {
    const result = await evaluatePageExpression("[1..500000]", scope, {
      maxSequence: 10_000,
    });
    expect(result.ok).toBe(false);
  });
});

describe("pageExpressionSyntaxError", () => {
  test("null for a valid expression, a message for a broken one", () => {
    expect(pageExpressionSyntaxError("$sum(data.sales.amount)")).toBeNull();
    expect(pageExpressionSyntaxError("$sum(")).toBeTypeOf("string");
  });
});

describe("isTruthyPageValue", () => {
  test("empty values are falsy so `show` hides empty sections", () => {
    expect(isTruthyPageValue(undefined)).toBe(false);
    expect(isTruthyPageValue(null)).toBe(false);
    expect(isTruthyPageValue(0)).toBe(false);
    expect(isTruthyPageValue("")).toBe(false);
    expect(isTruthyPageValue([])).toBe(false);
    expect(isTruthyPageValue([1])).toBe(true);
    expect(isTruthyPageValue("x")).toBe(true);
  });
});
