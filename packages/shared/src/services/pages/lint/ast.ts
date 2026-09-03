import { babelParse, parse as parseSfc } from "vue/compiler-sfc";

/**
 * Reading a page's script exactly, with no new dependency.
 *
 * `babelParse` comes from `vue/compiler-sfc`, which this package already
 * compiles every page with. The alternative — a character-level reader — was
 * tried and rejected in `sanitize.ts`: a regex mistakes spreads and nested
 * objects for what it is looking for, and a warning about a page that works is
 * worse than no warning.
 */

/** Enough of a Babel node to read one without importing `@babel/types`, which
 * is installed only as a transitive of `vue/compiler-sfc` and would have to
 * become a direct dependency to be imported by name. */
export interface AstNode {
  type: string;
  [key: string]: unknown;
}

export const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string";

export const visitAst = (value: unknown, fn: (node: AstNode) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) visitAst(item, fn);
    return;
  }
  if (!isAstNode(value)) return;
  fn(value);
  for (const key of Object.keys(value)) {
    if (key === "loc" || key === "leadingComments") continue;
    visitAst(value[key], fn);
  }
};

/** The non-computed name of an object property key, or null. */
export const propertyKeyName = (node: AstNode): string | null => {
  if (node.type !== "ObjectProperty" || node["computed"] === true) return null;
  const key = node["key"];
  if (!isAstNode(key)) return null;
  const name = key.type === "Identifier" ? key["name"] : key["value"];
  return typeof name === "string" ? name : null;
};

/** A node's line in the FILE, or 0 — what a finding prints. */
export const nodeLine = (node: AstNode): number => {
  const loc = node["loc"];
  if (typeof loc !== "object" || loc === null) return 0;
  const start = Reflect.get(loc, "start");
  if (typeof start !== "object" || start === null) return 0;
  const line = Reflect.get(start, "line");
  return typeof line === "number" ? line : 0;
};

/**
 * The script of a page file, parsed — a `.vue`'s `<script setup>` or a whole
 * `.ts`.
 *
 * Returns null on anything unparseable, which is deliberate: the compiler owns
 * that verdict and states it with a line number.
 *
 * Line numbers stay the FILE's. A `.vue`'s script block starts partway down the
 * file, so its own AST counts from 1 and every finding would point at the
 * template; `offset` is the correction.
 */
export const parsePageScript = (
  path: string,
  source: string,
): { ast: unknown; offset: number } | null => {
  let content = source;
  let offset = 0;
  if (path.endsWith(".vue")) {
    let block;
    try {
      const { descriptor } = parseSfc(source);
      block = descriptor.scriptSetup ?? descriptor.script;
    } catch {
      return null;
    }
    if (!block) return null;
    content = block.content;
    // `content` starts on the line AFTER the opening tag, and Babel counts its
    // own first line as 1.
    offset = block.loc.start.line - 1;
  }
  try {
    return {
      ast: babelParse(content, {
        sourceType: "module",
        plugins: ["typescript"],
      }).program,
      offset,
    };
  } catch {
    return null;
  }
};
