import { describe, expect, it } from "bun:test";
import { fixableSqlError } from "../../../../src/services/sql/execute";

/**
 * The SQL tool hides raw driver text by default, but surfaces the message for
 * the agent-fixable SQLSTATE classes so the model can correct a bad column /
 * table / syntax in one retry instead of looping (the reported `name` case).
 */
describe("fixableSqlError", () => {
  const pgErr = (code: string, message: string) =>
    Object.assign(new Error(message), { code });

  it("surfaces undefined_column (the reported `name` case)", () => {
    expect(
      fixableSqlError(pgErr("42703", 'column "name" does not exist')),
    ).toBe('column "name" does not exist.');
  });

  it("surfaces undefined_table and syntax errors", () => {
    expect(
      fixableSqlError(pgErr("42P01", 'relation "foo" does not exist')),
    ).toBe('relation "foo" does not exist.');
    expect(
      fixableSqlError(pgErr("42601", 'syntax error at or near "form"')),
    ).toBe('syntax error at or near "form".');
  });

  it("stays generic (null) for non-fixable classes and non-pg errors", () => {
    // Permission / internal classes are NOT surfaced.
    expect(fixableSqlError(pgErr("42501", "permission denied"))).toBeNull();
    expect(fixableSqlError(new Error("boom"))).toBeNull();
    expect(fixableSqlError("nope")).toBeNull();
    expect(fixableSqlError(null)).toBeNull();
  });

  it("appends the Postgres column/table suggestion hint when present", () => {
    const err = Object.assign(new Error('column "added_on" does not exist'), {
      code: "42703",
      hint: 'Perhaps you meant to reference the column "o.added".',
    });
    expect(fixableSqlError(err)).toBe(
      'column "added_on" does not exist. Perhaps you meant to reference the column "o.added".',
    );
  });

  it("collapses whitespace and caps the length", () => {
    const long = fixableSqlError(pgErr("42703", "x".repeat(400)));
    expect(long).not.toBeNull();
    expect((long ?? "").length).toBeLessThanOrEqual(201);
  });
});
