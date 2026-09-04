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

/** How far to descend through single-child wrappers before giving up. */
const MAX_WRAPPER_DEPTH = 4;

const elementChildren = (node: unknown): TemplateElement[] => {
  const children = Reflect.get(
    typeof node === "object" && node !== null ? node : {},
    "children",
  );
  if (!Array.isArray(children)) return [];
  const out: TemplateElement[] = [];
  for (const child of children) {
    if (typeof child !== "object" || child === null) continue;
    const tag = Reflect.get(child, "tag");
    if (typeof tag !== "string") continue;
    const props = Reflect.get(child, "props");
    const loc = Reflect.get(child, "loc");
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
  return out;
};

/**
 * The REGIONS of a screen — the first row of siblings, not every element.
 *
 * `templateElements` flattens, which is right for asking "is there a raw hue
 * anywhere in this file" and useless for asking "what is this page made of at
 * the top level". A page is a stack of regions; the wrappers above them
 * (`<template><div class="p-6">…`) carry padding and nothing else, so this
 * descends through them — as long as each has exactly one element child — and
 * returns the first level that actually branches.
 */
export const templateRegions = (source: string): TemplateElement[] => {
  let node: unknown;
  try {
    node = parseSfc(source).descriptor.template?.ast;
  } catch {
    return [];
  }
  if (node === undefined || node === null) return [];

  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH; depth++) {
    const children = elementChildren(node);
    if (children.length !== 1) return children;
    const only = Reflect.get(
      typeof node === "object" && node !== null ? node : {},
      "children",
    );
    if (!Array.isArray(only)) return children;
    const next = only.find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        typeof Reflect.get(child, "tag") === "string",
    );
    if (next === undefined) return children;
    node = next;
  }
  return [];
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
