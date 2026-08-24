import type { FormulaNode } from "./ast";
import { parseFormula } from "./parse";

/**
 * AST → formula source text. The inverse of `parse.ts`.
 *
 * It exists for the visual editor: the builder edits a TREE (pick a function,
 * fill its slots, nest another call inside one), and what gets stored is still
 * the expression text — one representation on disk, so a formula written in the
 * builder and one typed by hand are the same thing, and switching between the
 * two modes never loses anything.
 *
 * Parentheses are emitted from PRECEDENCE, not copied from the input, so a tree
 * assembled by clicking is printed correctly without the builder having to think
 * about grouping at all.
 */

/** Binding power per operator — the same table `parse.ts` reads. */
const POWER: Record<string, number> = {
  or: 1,
  and: 2,
  "=": 4,
  "<>": 4,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const NOT_POWER = 3;
const NEG_POWER = 7;

/** A text literal, in double quotes, with any inner quote doubled. */
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/**
 * Print `node`, wrapping it when its own binding power is looser than what the
 * surrounding position requires.
 *
 * `rightOfSame` handles the one asymmetric case: `a - (b - c)` must keep its
 * parentheses even though both sides bind equally, because the operators are
 * left-associative and dropping them would change the value.
 */
const print = (
  node: FormulaNode,
  minPower: number,
  rightOfSame = false,
): string => {
  switch (node.kind) {
    case "number":
      return String(node.value);
    case "text":
      return quote(node.value);
    case "boolean":
      return node.value ? "true" : "false";
    case "null":
      return "null";
    case "field":
      return node.key;
    case "call":
      return `${node.name}(${node.args.map((arg) => print(arg, 0)).join(", ")})`;
    case "unary": {
      const power = node.op === "not" ? NOT_POWER : NEG_POWER;
      const inner =
        node.op === "not"
          ? `not ${print(node.operand, NOT_POWER)}`
          : `-${print(node.operand, NEG_POWER)}`;
      return power < minPower ? `(${inner})` : inner;
    }
    case "binary": {
      const power = POWER[node.op] ?? 0;
      const text = `${print(node.left, power)} ${node.op} ${print(node.right, power, true)}`;
      return power < minPower || (rightOfSame && power === minPower)
        ? `(${text})`
        : text;
    }
  }
};

export const printFormula = (node: FormulaNode): string => print(node, 0);

/**
 * Text → AST → text. Used by the tests to prove the round-trip holds, and by
 * nothing at runtime: the editor parses once when it opens a formula and prints
 * on every edit, so the two directions never need to meet in one call.
 */
export const normalizeFormula = (source: string): string =>
  printFormula(parseFormula(source));
