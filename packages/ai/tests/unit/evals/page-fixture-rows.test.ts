import { describe, expect, it } from "bun:test";
import {
  BUDGET_TOTAL,
  ITEM_ROW_COUNT,
  itemRows,
  OWNERS,
  PRIORITIES,
  STATUSES,
  TEAMS,
  type FixtureItemRow,
} from "../../../evals/cases/page-fixture-rows";

/**
 * The fixture's job is to let a generated page show cross-analysis. It can only
 * do that if its dimensions are independent — and the first version's were not:
 * status and owner shared the modulus 4, so every "To do" belonged to the same
 * person and "by owner" drew the same chart as "by status". A whole eval run was
 * scored against that data before anyone opened a page and saw four uniform
 * columns.
 *
 * These tests fail if any pair collapses again.
 */

const SEEDED_AT = Date.UTC(2026, 5, 15);
const rows = itemRows(SEEDED_AT);

type Dimension = keyof Pick<
  FixtureItemRow,
  "status" | "priority" | "team" | "owner"
>;
const DIMENSIONS: Dimension[] = ["status", "priority", "team", "owner"];

/** How many distinct `b` values appear in the rows sharing each `a` value. */
const spread = (a: Dimension, b: Dimension): number[] => {
  const buckets = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row[a];
    const seen = buckets.get(key) ?? new Set<string>();
    seen.add(row[b]);
    buckets.set(key, seen);
  }
  return [...buckets.values()].map((seen) => seen.size);
};

describe("page fixture rows", () => {
  it("seeds the row count and budget total the assertions quote", () => {
    expect(rows).toHaveLength(ITEM_ROW_COUNT);
    const total = rows.reduce((sum, row) => sum + row.budget.amount, 0);
    expect(total).toBe(BUDGET_TOTAL);
  });

  it("keeps every dimension independent of every other", () => {
    // Every value of `a` must see at least three distinct `b` values. Two would
    // already be a near-collapse: it lets one chart stand in for another, which
    // is exactly what went unnoticed. Collected rather than asserted in the
    // loop, so a failure names the pair that collapsed instead of the first one.
    const collapsed = DIMENSIONS.flatMap((a) =>
      DIMENSIONS.filter((b) => b !== a).flatMap((b) => {
        const worst = Math.min(...spread(a, b));
        return worst < 3 ? [`${a} -> ${b} (worst ${worst.toString()})`] : [];
      }),
    );
    expect(collapsed).toEqual([]);
  });

  it("uses every declared option, so no lane or badge is dead", () => {
    for (const [dimension, options] of [
      ["status", STATUSES.map((s) => s.value)],
      ["priority", PRIORITIES.map((p) => p.value)],
      ["team", TEAMS.map((t) => t.value)],
      ["owner", OWNERS.map((o) => o.name)],
    ] as const) {
      const used = new Set(rows.map((row) => row[dimension]));
      expect([...used].sort()).toEqual([...options].sort());
    }
  });

  it("spreads effort past the two values a shared factor used to allow", () => {
    for (const status of STATUSES) {
      const efforts = new Set(
        rows.filter((r) => r.status === status.value).map((r) => r.effort),
      );
      expect(efforts.size).toBeGreaterThanOrEqual(4);
    }
  });

  it("straddles the seed day, so overdue is not a synonym for status", () => {
    const today = new Date(SEEDED_AT).toISOString().slice(0, 10);
    const past = rows.filter((row) => row.due_at < today);
    const future = rows.filter((row) => row.due_at > today);
    expect(past.length).toBeGreaterThanOrEqual(4);
    expect(future.length).toBeGreaterThanOrEqual(4);
    // The failure that made this matter: overdue was true of every row that was
    // not done, so a page filtering on it reproduced the status column.
    const overdueStatuses = new Set(past.map((row) => row.status));
    expect(overdueStatuses.size).toBeGreaterThanOrEqual(3);
  });

  it("moves with the seed day rather than sitting on constants", () => {
    const later = itemRows(SEEDED_AT + 90 * 24 * 60 * 60 * 1000);
    expect(later[0]?.due_at).not.toBe(rows[0]?.due_at);
    // Everything else is fixed: only the dates are relative.
    expect(later.map((r) => r.status)).toEqual(rows.map((r) => r.status));
    expect(later.map((r) => r.budget.amount)).toEqual(
      rows.map((r) => r.budget.amount),
    );
  });
});
