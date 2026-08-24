/**
 * The formula AST and its value types — the closed vocabulary every other file
 * in this directory agrees on.
 *
 * The grammar is CLOSED by design: a formula is compiled into the SQL of a
 * generated column, on a connection that bypasses row-level security, so the
 * safe posture is "these productions and nothing else" rather than "anything a
 * parser accepts minus what we reject". Every node below is producible only by
 * `parse.ts`; nothing here can carry raw SQL.
 */

import type { FormulaResultType } from "../../../db/schema/field-types";

/**
 * The value types a formula can produce. Deliberately small, and defined by the
 * SCHEMA (`FormulaResultType`) because the inferred type is persisted on the
 * field's config — one vocabulary, so the language and the stored value cannot
 * disagree.
 */
export type FormulaType = FormulaResultType;

/** Binary operators, in the surface syntax the author writes. */
export type FormulaBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

export type FormulaUnaryOp = "-" | "not";

/**
 * A node's `at` is the 0-based offset of its first character in the SOURCE
 * text, so an error can point at the exact spot. It is carried by every node
 * that can fail a check — the editor underlines it and the agent reads it.
 */
export type FormulaNode =
  | { kind: "number"; value: number; at: number }
  | { kind: "text"; value: string; at: number }
  | { kind: "boolean"; value: boolean; at: number }
  | { kind: "null"; at: number }
  | { kind: "field"; key: string; at: number }
  | { kind: "unary"; op: FormulaUnaryOp; operand: FormulaNode; at: number }
  | {
      kind: "binary";
      op: FormulaBinaryOp;
      left: FormulaNode;
      right: FormulaNode;
      at: number;
    }
  | { kind: "call"; name: string; args: FormulaNode[]; at: number };

/**
 * A refusal that names WHAT is wrong and WHERE.
 *
 * Thrown as a value, never as a raw `Error`: these messages are read by three
 * audiences — the person typing in the formula editor, the agent calling
 * `manageField`, and the developer reading a test failure — so they are written
 * as sentences, in English, and always name the offending token.
 */
export class FormulaError extends Error {
  /** 0-based offset in the source text. */
  readonly at: number;

  constructor(message: string, at: number) {
    super(message);
    this.name = "FormulaError";
    this.at = at;
  }
}
