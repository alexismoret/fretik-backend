import { parse as parseSfc } from "vue/compiler-sfc";

/**
 * Every element of a `<template>`, with its line in the file.
 *
 * Its own walker rather than `visitAst`: the template AST types its nodes with
 * a NUMERIC enum, so a walker that recognises a node by a string `type` walks
 * straight past every one of them (the same reason `sanitize.ts` grew a private
 * one for colours — this is that walker, factored out for the lints).
 *
 * Line numbers are the SFC's own: `compiler-sfc` keeps original positions, so
 * what a finding prints is what `pageRead` shows.
 */

export interface TemplateElement {
  tag: string;
  /** Prop nodes as the parser produced them — an attribute has `value`, a directive has `exp`. */
  props: unknown[];
  line: number;
}

const elementsOf = (node: unknown, out: TemplateElement[]): void => {
  if (Array.isArray(node)) {
    for (const item of node) elementsOf(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const tag = Reflect.get(node, "tag");
  if (typeof tag === "string") {
    const props = Reflect.get(node, "props");
    const loc = Reflect.get(node, "loc");
    const start =
      typeof loc === "object" && loc !== null
        ? Reflect.get(loc, "start")
        : undefined;
    const line =
      typeof start === "object" && start !== null
        ? Reflect.get(start, "line")
        : undefined;
    out.push({
      tag,
      props: Array.isArray(props) ? props : [],
      line: typeof line === "number" ? line : 0,
    });
  }
  elementsOf(Reflect.get(node, "children"), out);
  // `v-if` holds its children one level deeper, under each branch.
  elementsOf(Reflect.get(node, "branches"), out);
};

/**
 * Parse and flatten. An unparseable file yields nothing: the compiler owns that
 * verdict and states it with a line number, and a lint talking over it is noise.
 */
export const templateElements = (source: string): TemplateElement[] => {
  let root: unknown;
  try {
    root = parseSfc(source).descriptor.template?.ast;
  } catch {
    return [];
  }
  if (root === undefined || root === null) return [];
  const out: TemplateElement[] = [];
  elementsOf(root, out);
  return out;
};

/** The static value of an attribute (`color="primary"`), or null for a binding. */
export const staticProp = (
  element: TemplateElement,
  name: string,
): string | null => {
  for (const prop of element.props) {
    if (typeof prop !== "object" || prop === null) continue;
    if (Reflect.get(prop, "name") !== name) continue;
    const value = Reflect.get(prop, "value");
    if (typeof value !== "object" || value === null) continue;
    const content = Reflect.get(value, "content");
    if (typeof content === "string") return content;
  }
  return null;
};

/** Whether a prop is present at all, static or bound (`aria-pressed` / `:aria-pressed`). */
export const hasProp = (element: TemplateElement, name: string): boolean =>
  element.props.some((prop) => {
    if (typeof prop !== "object" || prop === null) return false;
    if (Reflect.get(prop, "name") === name) return true;
    // A directive keeps the attribute name in `arg.content`: `:aria-pressed`
    // parses as `{ name: "bind", arg: { content: "aria-pressed" } }`.
    const arg = Reflect.get(prop, "arg");
    return (
      typeof arg === "object" &&
      arg !== null &&
      Reflect.get(arg, "content") === name
    );
  });
