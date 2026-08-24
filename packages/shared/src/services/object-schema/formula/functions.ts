import type { FormulaType } from "./ast";

/**
 * The function table — the ONE place a formula function is declared, and the
 * only file that has to change to add one.
 *
 * Keeping functions in a table rather than in a `switch` inside the parser is
 * what keeps this language cheap to maintain: `parse.ts` already handles calls,
 * nesting and argument lists generically, so a new function is a row here (its
 * arity, its typing rule, its SQL) and nothing else.
 *
 * HARD CONSTRAINT on every `sql` emitter: the SQL it produces must be
 * IMMUTABLE. These expressions become the body of a `GENERATED ALWAYS AS (…)
 * STORED` column, and Postgres refuses anything else. That rules out `concat()`
 * (STABLE — we emit `||`), any `::date` / `::text` cast of a timestamptz (it
 * depends on the session TimeZone — we go through `extract(epoch from …)`
 * instead), and anything reading the clock. A function whose result could change
 * for an unchanged row does not belong here at all.
 */

/**
 * A resolved type, where `null` means "the NULL literal" — it has no type of
 * its own and takes the type of whatever it is combined with.
 */
export type InferredType = FormulaType | null;

/** A parameter's accepted type. `"any"` accepts all four. */
type ParamType = FormulaType | "any";

/**
 * One positional parameter. The `name` is not decoration: the visual builder
 * draws one labelled slot per parameter, so "later"/"earlier" on
 * `days_between` is the difference between a form somebody can fill and two
 * anonymous boxes they have to guess the order of.
 */
type FormulaParam = { name: string; type: ParamType };

export type FormulaFunction = {
  /** Positional parameters, in order. */
  params: FormulaParam[];
  /**
   * When set, the LAST entry of `params` repeats: `least(a, b, c, …)`. The
   * declared params are then the minimum arity.
   */
  variadic?: boolean;
  /**
   * Result type. A function of the argument types when it depends on them
   * (`coalesce`, `least`, `if`); a fixed type otherwise. Returning `undefined`
   * means the arguments contradict each other — the checker turns that into a
   * sentence naming both kinds.
   */
  result: FormulaType | ((args: InferredType[]) => InferredType | undefined);
  /** Already-emitted argument SQL → this call's SQL. Must be IMMUTABLE. */
  sql: (args: string[]) => string;
  /** One line, shown in the formula editor's function list. */
  hint: string;
};

/**
 * Unify the types of values that must agree (`coalesce`, `least`, `if`'s two
 * branches). A NULL literal agrees with anything; two concrete types must be
 * equal. Returns `undefined` when they conflict, which the checker turns into a
 * named error.
 */
export const unifyTypes = (types: InferredType[]): InferredType | undefined => {
  let resolved: InferredType = null;
  for (const type of types) {
    if (type === null) continue;
    if (resolved === null) {
      resolved = type;
      continue;
    }
    if (resolved !== type) return undefined;
  }
  return resolved;
};

/** Wrap an argument so operator precedence can never leak between fragments. */
const p = (sql: string): string => `(${sql})`;

/**
 * `round`/`ceil`/`floor` with a digit count exist only for `numeric` in
 * Postgres, so the value is cast on the way in. `float8 → numeric` is an
 * immutable cast, and the generated column casts back to its declared type.
 */
const toNumeric = (sql: string): string => `${p(sql)}::numeric`;

export const FORMULA_FUNCTIONS: Record<string, FormulaFunction> = {
  round: {
    params: [
      { name: "value", type: "number" },
      { name: "digits", type: "number" },
    ],
    // The digit count is optional; declared as 2 params with a 1-param form
    // handled by the arity check below (see `arityOf`).
    result: "number",
    sql: (a) =>
      a.length === 1
        ? `round(${toNumeric(a[0] ?? "")})`
        : `round(${toNumeric(a[0] ?? "")}, ${p(a[1] ?? "")}::int)`,
    hint: "round(value) or round(value, digits)",
  },
  abs: {
    params: [{ name: "value", type: "number" }],
    result: "number",
    sql: (a) => `abs(${p(a[0] ?? "")})`,
    hint: "abs(value) — drops the sign",
  },
  ceil: {
    params: [{ name: "value", type: "number" }],
    result: "number",
    sql: (a) => `ceil(${p(a[0] ?? "")})`,
    hint: "ceil(value) — rounds up",
  },
  floor: {
    params: [{ name: "value", type: "number" }],
    result: "number",
    sql: (a) => `floor(${p(a[0] ?? "")})`,
    hint: "floor(value) — rounds down",
  },
  least: {
    params: [
      { name: "value", type: "any" },
      { name: "value", type: "any" },
    ],
    variadic: true,
    result: unifyTypes,
    sql: (a) => `least(${a.map(p).join(", ")})`,
    hint: "least(a, b, …) — the smallest of the values ON THIS ROW",
  },
  greatest: {
    params: [
      { name: "value", type: "any" },
      { name: "value", type: "any" },
    ],
    variadic: true,
    result: unifyTypes,
    sql: (a) => `greatest(${a.map(p).join(", ")})`,
    hint: "greatest(a, b, …) — the largest of the values ON THIS ROW",
  },
  coalesce: {
    params: [
      { name: "value", type: "any" },
      { name: "fallback", type: "any" },
    ],
    variadic: true,
    result: unifyTypes,
    sql: (a) => `coalesce(${a.map(p).join(", ")})`,
    hint: "coalesce(a, b, …) — the first value that is not empty",
  },
  nullif: {
    params: [
      { name: "value", type: "any" },
      { name: "empty when", type: "any" },
    ],
    result: (args) => unifyTypes(args),
    sql: (a) => `nullif(${p(a[0] ?? "")}, ${p(a[1] ?? "")})`,
    hint: "nullif(a, b) — empty when a equals b",
  },
  length: {
    params: [{ name: "text", type: "text" }],
    result: "number",
    sql: (a) => `length(${p(a[0] ?? "")})`,
    hint: "length(text) — number of characters",
  },
  lower: {
    params: [{ name: "text", type: "text" }],
    result: "text",
    sql: (a) => `lower(${p(a[0] ?? "")})`,
    hint: "lower(text)",
  },
  upper: {
    params: [{ name: "text", type: "text" }],
    result: "text",
    sql: (a) => `upper(${p(a[0] ?? "")})`,
    hint: "upper(text)",
  },
  trim: {
    params: [{ name: "text", type: "text" }],
    result: "text",
    sql: (a) => `btrim(${p(a[0] ?? "")})`,
    hint: "trim(text) — removes surrounding spaces",
  },
  concat: {
    params: [
      { name: "text", type: "text" },
      { name: "text", type: "text" },
    ],
    variadic: true,
    result: "text",
    // `||` rather than `concat()`: the function is STABLE, the operator is
    // immutable. `||` yields NULL if any part is NULL, so each part is defaulted
    // to an empty string — joining a name to a missing one must not erase both.
    sql: (a) => a.map((arg) => `coalesce(${p(arg)}, '')`).join(" || "),
    hint: "concat(a, b, …) — joins text",
  },
  text: {
    params: [{ name: "value", type: "any" }],
    result: "text",
    // Only reachable for number/boolean — the checker refuses `date` here,
    // because rendering an instant depends on the session time zone.
    sql: (a) => `${p(a[0] ?? "")}::text`,
    hint: "text(value) — a number or checkbox as text",
  },
  if: {
    params: [
      { name: "condition", type: "boolean" },
      { name: "then", type: "any" },
      { name: "otherwise", type: "any" },
    ],
    result: (args) => unifyTypes([args[1] ?? null, args[2] ?? null]),
    sql: (a) =>
      `CASE WHEN ${p(a[0] ?? "")} THEN ${p(a[1] ?? "")} ELSE ${p(a[2] ?? "")} END`,
    hint: "if(condition, then, else)",
  },
  days_between: {
    params: [
      { name: "later", type: "date" },
      { name: "earlier", type: "date" },
    ],
    result: "number",
    // Subtracting two instants yields an `interval`, and `extract(epoch …)` on
    // an interval is immutable — unlike `::date`, which would silently depend on
    // the session time zone and be refused by the generated column.
    sql: (a) =>
      `floor(extract(epoch from (${p(a[0] ?? "")} - ${p(a[1] ?? "")})) / 86400)`,
    hint: "days_between(later, earlier) — whole days between two dates",
  },
};

/**
 * Accepted arity range for a function. `round` is the one function with an
 * optional argument, so the minimum is declared here rather than adding an
 * `optional` flag every other row would carry as `false`.
 */
export const arityOf = (
  name: string,
  fn: FormulaFunction,
): { min: number; max: number } => {
  const declared = fn.params.length;
  if (name === "round") return { min: 1, max: 2 };
  return {
    min: declared,
    max: fn.variadic ? Number.MAX_SAFE_INTEGER : declared,
  };
};

/** Every function name, for error messages and the editor's palette. */
export const FORMULA_FUNCTION_NAMES: string[] =
  Object.keys(FORMULA_FUNCTIONS).sort();
