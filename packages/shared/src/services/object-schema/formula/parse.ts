import type { FormulaBinaryOp, FormulaNode } from "./ast";
import { FormulaError } from "./ast";

/**
 * Tokenizer + Pratt parser for the formula language: source text → AST.
 *
 * This stage knows nothing about fields, types or SQL — it only decides whether
 * the text is a well-formed expression. Written by hand rather than taken from
 * a library because the grammar IS the security boundary (see `ast.ts`): a
 * hand-rolled parser accepts exactly these productions, where a general-purpose
 * expression parser would accept a superset we would then have to police. The
 * cost is bounded — the grammar is closed, and new FUNCTIONS are added to the
 * table in `functions.ts` without touching a line of this file.
 */

type TokenType = "number" | "text" | "name" | "op" | "(" | ")" | "," | "end";

type Token = { type: TokenType; value: string; at: number };

/** Multi-character operators first — longest match wins. */
const OPERATORS = [
  "<=",
  ">=",
  "<>",
  "!=",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
];

/** Words that are operators or literals, never field keys. */
const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isNameStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isNameChar = (c: string): boolean => isNameStart(c) || isDigit(c);

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i] ?? "";

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    if (c === "(" || c === ")" || c === ",") {
      tokens.push({ type: c, value: c, at: i });
      i++;
      continue;
    }

    // A number literal. A leading `-` is always unary minus, never part of the
    // literal, so `a-1` tokenizes as three tokens rather than `a` and `-1`.
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (isDigit(source[i] ?? "")) i++;
      if (source[i] === ".") {
        i++;
        while (isDigit(source[i] ?? "")) i++;
      }
      const raw = source.slice(start, i);
      // A trailing name character means something like `12abc` — reject it here
      // rather than letting `12` parse and `abc` become a mystery field.
      if (isNameChar(source[i] ?? "")) {
        throw new FormulaError(`\`${raw}\` is not a valid number.`, start);
      }
      tokens.push({ type: "number", value: raw, at: start });
      continue;
    }

    // A text literal, in double or single quotes. A quote is doubled to escape
    // itself ("say ""hi""") — the SQL convention, and it keeps backslashes out
    // of a language whose output is SQL.
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = "";
      for (;;) {
        if (i >= source.length) {
          throw new FormulaError(
            "This text is missing its closing quote.",
            start,
          );
        }
        if (source[i] === quote) {
          if (source[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i];
        i++;
      }
      tokens.push({ type: "text", value, at: start });
      continue;
    }

    if (isNameStart(c)) {
      const start = i;
      while (isNameChar(source[i] ?? "")) i++;
      const raw = source.slice(start, i);
      const lower = raw.toLowerCase();
      tokens.push({
        type: KEYWORDS.has(lower) ? "op" : "name",
        value: KEYWORDS.has(lower) ? lower : raw,
        at: start,
      });
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      // `!=` is accepted as a spelling of `<>`; the AST keeps one form.
      tokens.push({ type: "op", value: op === "!=" ? "<>" : op, at: i });
      i += op.length;
      continue;
    }

    throw new FormulaError(`\`${c}\` is not something a formula can use.`, i);
  }

  tokens.push({ type: "end", value: "", at: source.length });
  return tokens;
};

/**
 * Binding power per infix operator. Higher binds tighter; the shape mirrors
 * SQL's own precedence so a formula reads the way its author expects.
 */
const INFIX_POWER: Record<string, number> = {
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

/** `not` binds looser than any comparison (`not a = b` is `not (a = b)`). */
const NOT_POWER = 3;
/** Unary minus binds tighter than any arithmetic (`-a * b` is `(-a) * b`). */
const NEG_POWER = 7;

/** Nesting depth cap — a guard against pathological input, never hit in practice. */
const MAX_DEPTH = 32;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    // The token list always ends with `end`, so this never returns undefined.
    return this.tokens[this.pos] ?? { type: "end", value: "", at: 0 };
  }

  private next(): Token {
    const token = this.peek();
    this.pos++;
    return token;
  }

  private expect(type: TokenType, what: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new FormulaError(`Expected ${what} here.`, token.at);
    }
    return this.next();
  }

  parse(): FormulaNode {
    const node = this.expression(0);
    const trailing = this.peek();
    if (trailing.type !== "end") {
      throw new FormulaError(
        `\`${trailing.value}\` is unexpected here — is an operator missing before it?`,
        trailing.at,
      );
    }
    return node;
  }

  /** Pratt loop: parse a prefix, then absorb infix operators that bind tighter. */
  private expression(minPower: number): FormulaNode {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaError(
        "This formula nests too deeply — split it into several fields.",
        this.peek().at,
      );
    }
    let left = this.prefix();

    for (;;) {
      const token = this.peek();
      if (token.type !== "op") break;
      const power = INFIX_POWER[token.value];
      if (power === undefined || power <= minPower) break;
      this.next();
      // Left-associative: the right side must bind strictly tighter.
      const right = this.expression(power);
      left = {
        kind: "binary",
        op: token.value as FormulaBinaryOp,
        left,
        right,
        at: token.at,
      };
    }

    this.depth--;
    return left;
  }

  private prefix(): FormulaNode {
    const token = this.next();

    switch (token.type) {
      case "number": {
        const value = Number(token.value);
        if (!Number.isFinite(value)) {
          throw new FormulaError(
            `\`${token.value}\` is not a valid number.`,
            token.at,
          );
        }
        return { kind: "number", value, at: token.at };
      }
      case "text":
        return { kind: "text", value: token.value, at: token.at };
      case "(": {
        const inner = this.expression(0);
        this.expect(")", "a closing `)`");
        return inner;
      }
      case "name": {
        if (this.peek().type === "(") {
          this.next();
          const args: FormulaNode[] = [];
          if (this.peek().type !== ")") {
            for (;;) {
              args.push(this.expression(0));
              if (this.peek().type !== ",") break;
              this.next();
            }
          }
          this.expect(")", "a closing `)`");
          return {
            kind: "call",
            name: token.value.toLowerCase(),
            args,
            at: token.at,
          };
        }
        return { kind: "field", key: token.value, at: token.at };
      }
      case "op": {
        if (token.value === "true" || token.value === "false") {
          return {
            kind: "boolean",
            value: token.value === "true",
            at: token.at,
          };
        }
        if (token.value === "null") return { kind: "null", at: token.at };
        if (token.value === "-") {
          return {
            kind: "unary",
            op: "-",
            operand: this.expression(NEG_POWER),
            at: token.at,
          };
        }
        if (token.value === "not") {
          return {
            kind: "unary",
            op: "not",
            operand: this.expression(NOT_POWER),
            at: token.at,
          };
        }
        throw new FormulaError(
          `\`${token.value}\` needs a value before it.`,
          token.at,
        );
      }
      default:
        throw new FormulaError(
          token.type === "end"
            ? "This formula is incomplete."
            : `\`${token.value}\` is unexpected here.`,
          token.at,
        );
    }
  }
}

/** Source text → AST. Throws a `FormulaError` carrying a position. */
export const parseFormula = (source: string): FormulaNode => {
  if (source.trim().length === 0) {
    throw new FormulaError("A formula cannot be empty.", 0);
  }
  return new Parser(tokenize(source)).parse();
};
