import type { FieldDefinition } from "../../../db/schema";
import type { FieldDefinitionType } from "../../../db/schema/field-types";
import { columnsForField } from "../columns";
import type { FormulaNode, FormulaType } from "./ast";
import { FormulaError } from "./ast";
import {
  arityOf,
  FORMULA_FUNCTION_NAMES,
  FORMULA_FUNCTIONS,
  type InferredType,
  unifyTypes,
} from "./functions";
import { parseFormula } from "./parse";

/**
 * Type-check an AST against a type's real fields and emit its SQL, in one walk.
 *
 * Checking and emitting are the same traversal on purpose: every node's SQL
 * depends on the types it just resolved (division casts, `round` needs numeric,
 * text comparison differs from numeric), so splitting them would mean walking
 * the tree twice and keeping the two dispatches in step by hand.
 *
 * NOTHING the caller wrote reaches the output. Identifiers are re-derived from
 * `columnsForField` (which re-validates the slug), literals are re-serialised
 * from parsed values, and operators/functions come from closed tables — so a
 * field key or a string literal cannot carry SQL out of this file.
 */

/** Where a formula reads a value from, once resolved against the catalog. */
type Resolution =
  | { kind: "column"; column: string; type: FormulaType }
  | { kind: "formula"; source: string }
  | { kind: "refused"; reason: string };

/**
 * Why a field type cannot appear in a formula. Written as the sentence the
 * author reads, because "unsupported field type" sends nobody anywhere.
 */
const REFUSALS: Partial<Record<FieldDefinitionType, string>> = {
  relation:
    "is a link to other records; a formula reads the fields stored on this row",
  rollup:
    "is already an aggregate over linked records; a formula cannot read one (use the rollup itself, or a second rollup)",
  multi_select:
    "holds several values at once, which arithmetic has no meaning for",
  member: "holds a teammate, not a value a formula can compute with",
  location: "holds a place; a formula cannot compute with an address",
  created_time: "is a system property, stored outside the record's own columns",
  last_edited_time:
    "is a system property, stored outside the record's own columns",
  created_by: "is a system property, stored outside the record's own columns",
  last_edited_by:
    "is a system property, stored outside the record's own columns",
};

/** Value type a field contributes to a formula, or undefined if it has none. */
const formulaTypeOf = (type: FieldDefinitionType): FormulaType | undefined => {
  switch (type) {
    case "number":
    case "rating":
    case "unique_id":
    case "money":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    case "text":
    case "markdown":
    case "phone":
    case "url":
    case "email":
    case "select":
      return "text";
    default:
      return undefined;
  }
};

/** Formula source carried on a `formula` field's config, if any. */
const formulaSourceOf = (def: FieldDefinition): string | undefined =>
  "expression" in def.config && typeof def.config.expression === "string"
    ? def.config.expression
    : undefined;

const resolveField = (def: FieldDefinition): Resolution => {
  if (def.type === "formula") {
    const source = formulaSourceOf(def);
    return source
      ? { kind: "formula", source }
      : { kind: "refused", reason: "has no formula yet" };
  }
  const refusal = REFUSALS[def.type];
  if (refusal) return { kind: "refused", reason: refusal };

  const type = formulaTypeOf(def.type);
  const [column] = columnsForField(def);
  if (!type || !column) {
    return {
      kind: "refused",
      reason: `is a ${def.type} field, which a formula cannot read`,
    };
  }
  return { kind: "column", column: column.name, type };
};

/** A text literal, SQL-escaped by doubling quotes — the only escape SQL needs. */
const textLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/**
 * How deep a formula may reference another formula. Five is far past any real
 * chain and keeps a pathological catalog from expanding into a huge expression.
 */
const MAX_INLINE_DEPTH = 5;

type Walk = { sql: string; type: InferredType };

class Compiler {
  private readonly byKey: Map<string, FieldDefinition>;
  private readonly alias: string;
  /** Formula field keys currently being inlined — the cycle detector. */
  private readonly inlining: string[] = [];

  constructor(fields: FieldDefinition[], alias?: string) {
    this.byKey = new Map(fields.map((f) => [f.key, f]));
    this.alias = alias ? `${alias}.` : "";
  }

  compile(source: string): Walk {
    return this.walk(parseFormula(source));
  }

  private walk(node: FormulaNode): Walk {
    switch (node.kind) {
      case "number":
        // Re-serialised from the parsed value, never echoed from the source.
        return { sql: String(node.value), type: "number" };
      case "text":
        return { sql: textLiteral(node.value), type: "text" };
      case "boolean":
        return { sql: node.value ? "true" : "false", type: "boolean" };
      case "null":
        return { sql: "NULL", type: null };
      case "field":
        return this.field(node);
      case "unary":
        return this.unary(node);
      case "binary":
        return this.binary(node);
      case "call":
        return this.call(node);
    }
  }

  private field(node: FormulaNode & { kind: "field" }): Walk {
    const def = this.byKey.get(node.key);
    if (!def) {
      throw new FormulaError(
        `There is no field called \`${node.key}\` on this collection.`,
        node.at,
      );
    }
    if (!def.enabled) {
      throw new FormulaError(
        `\`${def.label}\` is disabled — a formula can only read active fields.`,
        node.at,
      );
    }

    const resolved = resolveField(def);
    if (resolved.kind === "refused") {
      throw new FormulaError(`\`${def.label}\` ${resolved.reason}.`, node.at);
    }
    if (resolved.kind === "column") {
      return { sql: `${this.alias}"${resolved.column}"`, type: resolved.type };
    }

    // A formula reading a formula is INLINED rather than referenced: a Postgres
    // generated column cannot read another generated column, and inlining also
    // means the stored SQL never goes stale when the inner formula changes —
    // the outer column is rebuilt from source at the same moment.
    if (this.inlining.includes(def.key)) {
      const cycle = [...this.inlining, def.key].join(" → ");
      throw new FormulaError(
        `These formulas reference each other in a loop: ${cycle}.`,
        node.at,
      );
    }
    if (this.inlining.length >= MAX_INLINE_DEPTH) {
      throw new FormulaError(
        `\`${def.label}\` is too many formulas deep — flatten the chain.`,
        node.at,
      );
    }
    this.inlining.push(def.key);
    let inner: Walk;
    try {
      inner = this.walk(parseFormula(resolved.source));
    } catch (error) {
      // The inner formula's position belongs to ITS source, which the reader is
      // not looking at — re-anchor the message on the reference they wrote.
      if (error instanceof FormulaError) {
        throw new FormulaError(
          `\`${def.label}\` cannot be used here — its own formula fails: ${error.message}`,
          node.at,
        );
      }
      throw error;
    } finally {
      this.inlining.pop();
    }
    return { sql: `(${inner.sql})`, type: inner.type };
  }

  private unary(node: FormulaNode & { kind: "unary" }): Walk {
    const operand = this.walk(node.operand);
    if (node.op === "-") {
      this.expect(operand.type, "number", node.at, "`-` negates a number");
      return { sql: `(-(${operand.sql}))`, type: "number" };
    }
    this.expect(operand.type, "boolean", node.at, "`not` needs a yes/no value");
    return { sql: `(NOT (${operand.sql}))`, type: "boolean" };
  }

  private binary(node: FormulaNode & { kind: "binary" }): Walk {
    const left = this.walk(node.left);
    const right = this.walk(node.right);
    const op = node.op;

    if (op === "and" || op === "or") {
      this.expect(
        left.type,
        "boolean",
        node.at,
        `\`${op}\` joins yes/no values`,
      );
      this.expect(
        right.type,
        "boolean",
        node.at,
        `\`${op}\` joins yes/no values`,
      );
      return {
        sql: `((${left.sql}) ${op.toUpperCase()} (${right.sql}))`,
        type: "boolean",
      };
    }

    if (
      op === "=" ||
      op === "<>" ||
      op === "<" ||
      op === "<=" ||
      op === ">" ||
      op === ">="
    ) {
      const unified = unifyTypes([left.type, right.type]);
      if (unified === undefined) {
        throw new FormulaError(
          `\`${op}\` cannot compare a ${this.name(left.type)} with a ${this.name(right.type)}.`,
          node.at,
        );
      }
      return {
        sql: `((${left.sql}) ${op} (${right.sql}))`,
        type: "boolean",
      };
    }

    this.expect(left.type, "number", node.at, `\`${op}\` works on numbers`);
    this.expect(right.type, "number", node.at, `\`${op}\` works on numbers`);

    if (op === "/" || op === "%") {
      // Two guards in one line. `NULLIF(divisor, 0)` makes a division by zero
      // yield an empty cell instead of aborting the whole query with a 22012 —
      // a formula must never be able to take a page down. The `::numeric` cast
      // stops integer division from truncating (a `unique_id` divided by 2
      // would otherwise floor), so `3 / 2` is 1.5 the way its author expects.
      return {
        sql: `(((${left.sql})::numeric) ${op} NULLIF((${right.sql}), 0))`,
        type: "number",
      };
    }
    return { sql: `((${left.sql}) ${op} (${right.sql}))`, type: "number" };
  }

  private call(node: FormulaNode & { kind: "call" }): Walk {
    const fn = FORMULA_FUNCTIONS[node.name];
    if (!fn) {
      throw new FormulaError(
        `There is no function called \`${node.name}\`. Available: ${FORMULA_FUNCTION_NAMES.join(", ")}.`,
        node.at,
      );
    }
    const arity = arityOf(node.name, fn);
    if (node.args.length < arity.min || node.args.length > arity.max) {
      throw new FormulaError(
        `\`${node.name}\` takes ${fn.variadic ? `at least ${arity.min}` : arity.min === arity.max ? `${arity.min}` : `${arity.min} or ${arity.max}`} argument${arity.min === 1 && !fn.variadic ? "" : "s"} — ${fn.hint}.`,
        node.at,
      );
    }

    const walked = node.args.map((arg) => this.walk(arg));
    walked.forEach((arg, index) => {
      // A variadic function repeats its LAST parameter, so anything past the
      // declared list is checked against that one.
      const param = fn.params[Math.min(index, fn.params.length - 1)];
      if (!param || param.type === "any") return;
      this.expect(
        arg.type,
        param.type,
        node.args[index]?.at ?? node.at,
        `${node.name}: ${fn.hint}`,
      );
    });

    // `text(date)` is refused HERE rather than by the param types: the function
    // takes anything else, and the reason is specific — formatting an instant
    // depends on a time zone, which a stored column may not depend on.
    if (node.name === "text" && walked[0]?.type === "date") {
      throw new FormulaError(
        "`text` cannot turn a date into text — how a date reads depends on the reader's time zone.",
        node.args[0]?.at ?? node.at,
      );
    }

    const types = walked.map((w) => w.type);
    const result =
      typeof fn.result === "function" ? fn.result(types) : fn.result;
    if (result === undefined) {
      throw new FormulaError(
        `\`${node.name}\` needs its values to be the same kind, but got ${types.map((t) => this.name(t)).join(" and ")}.`,
        node.at,
      );
    }
    return { sql: fn.sql(walked.map((w) => w.sql)), type: result };
  }

  /** Human name of a type, for error sentences. */
  private name(type: InferredType): string {
    if (type === null) return "empty value";
    return { number: "number", text: "text", boolean: "yes/no", date: "date" }[
      type
    ];
  }

  private expect(
    actual: InferredType,
    expected: FormulaType,
    at: number,
    context: string,
  ): void {
    // The NULL literal is accepted everywhere — it is the empty cell, and every
    // column can hold one.
    if (actual === null || actual === expected) return;
    throw new FormulaError(
      `${context}, but this is a ${this.name(actual)}.`,
      at,
    );
  }
}

export type CompiledFormula = {
  /** The SQL expression. Safe to embed in DDL — nothing here came from input text. */
  sql: string;
  /** Inferred result type. Stored on the field's config; never declared by hand. */
  resultType: FormulaType;
  /** Keys of the fields this formula reads, INCLUDING through inlined formulas. */
  dependsOn: string[];
};

/**
 * Compile a formula against a collection's fields.
 *
 * Throws `FormulaError` (message + position) for anything wrong — unknown field,
 * type mismatch, unknown function, cycle. Callers turn that into a 400 for a
 * person or a named tool error for the agent; nothing else should be caught.
 *
 * `alias` prefixes every column (`e."amount"`) for use inside a query. Omit it
 * for a generated column, whose expression references bare column names.
 */
export const compileFormula = (input: {
  source: string;
  fields: FieldDefinition[];
  alias?: string;
}): CompiledFormula => {
  const compiler = new Compiler(input.fields, input.alias);
  const { sql, type } = compiler.compile(input.source);
  if (type === null) {
    throw new FormulaError(
      "This formula always produces an empty value — it needs to compute something.",
      0,
    );
  }
  return { sql, resultType: type, dependsOn: dependenciesOf(input) };
};

/**
 * Field keys a formula reads, following formula references. Computed by
 * re-parsing rather than threaded through the compile walk: the walk INLINES,
 * so the same key can appear at several depths, and the callers that need this
 * (the delete/rename guard) want the flat set, not the tree.
 */
const dependenciesOf = (input: {
  source: string;
  fields: FieldDefinition[];
}): string[] => {
  const byKey = new Map(input.fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const visit = (source: string, depth: number): void => {
    if (depth > MAX_INLINE_DEPTH) return;
    for (const key of referencedKeys(parseFormula(source))) {
      if (seen.has(key)) continue;
      seen.add(key);
      const def = byKey.get(key);
      const nested =
        def && def.type === "formula" ? formulaSourceOf(def) : undefined;
      if (nested) visit(nested, depth + 1);
    }
  };
  visit(input.source, 0);
  return [...seen];
};

const referencedKeys = (node: FormulaNode): string[] => {
  switch (node.kind) {
    case "field":
      return [node.key];
    case "unary":
      return referencedKeys(node.operand);
    case "binary":
      return [...referencedKeys(node.left), ...referencedKeys(node.right)];
    case "call":
      return node.args.flatMap(referencedKeys);
    default:
      return [];
  }
};
