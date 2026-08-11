import { describe, expect, test } from "bun:test";
import {
  COMMON_PROPS,
  pagesCatalog,
  pagesCatalogPrompt,
} from "../src/catalogs/pages";
import { shapeOf } from "../src/core/props";

/**
 * Invariants of the catalog itself.
 *
 * This is the drift guard. `meta.bindable`, `meta.datasetProps`,
 * `meta.responsive` and `notes` all name props as STRINGS — a typo in any of
 * them is silent: the runtime simply never binds, the validator never widens,
 * the note documents a prop nobody can set. Cheap to assert, expensive to find
 * in production.
 */

const components = pagesCatalog.data.components;

const namesIn = (meta: unknown, key: string): string[] => {
  if (typeof meta !== "object" || meta === null) return [];
  const value: unknown = Reflect.get(meta, key);
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
};

// Entries omit whatever they have nothing to say about, so `Object.entries`
// yields a union in which `notes` / `meta` / `description` exist only on some
// members. Read them off the value, not off the type.
const field = (entry: unknown, key: string): unknown =>
  typeof entry === "object" && entry !== null
    ? Reflect.get(entry, key)
    : undefined;

const keysOf = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.keys(value) : [];

/** Element-level fields — a prop with one of these names would be shadowed. */
const ELEMENT_FIELDS = new Set([
  "type",
  "props",
  "children",
  "visible",
  "on",
  "repeat",
  "watch",
]);

describe("pages catalog", () => {
  test("every meta reference names a prop that exists", () => {
    const dangling: string[] = [];
    for (const [type, entry] of Object.entries(components)) {
      const shape = shapeOf(entry.props);
      for (const key of ["bindable", "datasetProps", "responsive"]) {
        for (const prop of namesIn(field(entry, "meta"), key)) {
          if (!(prop in shape)) dangling.push(`${type}.meta.${key}: ${prop}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test("every note names a prop that exists", () => {
    const dangling: string[] = [];
    for (const [type, entry] of Object.entries(components)) {
      const shape = shapeOf(entry.props);
      for (const prop of keysOf(field(entry, "notes"))) {
        if (!(prop in shape)) dangling.push(`${type}.notes: ${prop}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  test("no prop shadows an element field", () => {
    const shadowed: string[] = [];
    for (const [type, entry] of Object.entries(components)) {
      for (const prop of Object.keys(shapeOf(entry.props))) {
        if (ELEMENT_FIELDS.has(prop)) shadowed.push(`${type}.${prop}`);
      }
    }
    expect(shadowed).toEqual([]);
  });

  // Common props are merged in by `validatePageProps`; a component redeclaring
  // one would win silently and could give it different values.
  test("no component redeclares a common prop", () => {
    const common = Object.keys(shapeOf(COMMON_PROPS));
    const clashes: string[] = [];
    for (const [type, entry] of Object.entries(components)) {
      for (const prop of Object.keys(shapeOf(entry.props))) {
        if (common.includes(prop)) clashes.push(`${type}.${prop}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  test("every component is described", () => {
    const undescribed = Object.entries(components)
      .filter(([, entry]) => !entry.description)
      .map(([type]) => type);
    expect(undescribed).toEqual([]);
  });

  test("the prompt names every component and every action", () => {
    const prompt = pagesCatalogPrompt();
    for (const type of pagesCatalog.componentNames) {
      expect(prompt).toContain(`· ${type}`);
    }
    for (const action of pagesCatalog.actionNames) {
      expect(prompt).toContain(`· ${action}`);
    }
  });

  // Every scale printed as `@name` must be spelled out, and nothing else
  // should be: the table is generated from what the components reference.
  test("the prompt defines exactly the scales it references", () => {
    const prompt = pagesCatalogPrompt();
    const defined = new Set(
      [...prompt.matchAll(/^@(\w+):/gm)].map((m) => m[1] ?? ""),
    );
    const referenced = new Set(
      [...prompt.matchAll(/[?:] @(\w+)/g)].map((m) => m[1] ?? ""),
    );
    expect([...referenced].filter((s) => !defined.has(s))).toEqual([]);
    expect([...defined].filter((s) => !referenced.has(s))).toEqual([]);
  });

  /**
   * A growth alarm, not a straitjacket.
   *
   * This prompt is served on demand and then sits in the conversation, so every
   * character is paid for on each subsequent turn. It had no size assertion at
   * all, which is how ~1.2 KB of chart notes came to be printed three and four
   * times over. The ceiling is the 2026-08-10 measurement plus 10%: adding a
   * component is expected to fit, and a duplication is not.
   *
   * Raising it is a legitimate move — but a deliberate one, with the new
   * measurement recorded here.
   */
  test("the prompt stays within its size ceiling", () => {
    const CEILING_CHARS = 18_400;
    const size = pagesCatalogPrompt().length;
    expect(size).toBeLessThanOrEqual(CEILING_CHARS);
  });
});
