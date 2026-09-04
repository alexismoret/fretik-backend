import { describe, expect, test } from "bun:test";
import {
  dropRulesDeclaredBy,
  unconditionalSelectors,
} from "../../src/services/pages/css-rules";

/**
 * The two directions this pair has to get right, both measured in a browser on
 * 2026-09-04 on the same generated page:
 *
 * - a page re-declaring `.px-2` moved it AFTER the runtime's `.ps-7`, so every
 *   `<UInput icon>` lost its leading padding and drew the icon over its own
 *   placeholder. Dropping the duplicate fixes it.
 * - the first attempt at that fix put the whole page sheet in a losing cascade
 *   layer, which broke `hidden sm:block`: a layer beats a media query, so the
 *   base class won at every width and the desktop table never appeared. That
 *   is why the media blocks stay exactly where they are.
 */

describe("what a stylesheet declares unconditionally", () => {
  test("sees through layers and stops at media queries", () => {
    const css = [
      "@layer theme, base, utilities;",
      "@layer utilities{.px-2{padding-inline:.5rem}.ps-7{padding-inline-start:1.75rem}",
      "@media (min-width:40rem){.sm\\:block{display:block}}}",
    ].join("");
    expect(unconditionalSelectors(css)).toEqual([".ps-7", ".px-2"]);
  });

  test("splits a selector list on its top-level commas only", () => {
    const css = "@layer utilities{.a,.b{color:red}.c:is(.d,.e){color:blue}}";
    const found = unconditionalSelectors(css);
    expect(found).toContain(".a");
    expect(found).toContain(".b");
    // `:is(...)` is one selector, not two — a comma inside parentheses that
    // split the list would mint the junk keys `.c:is(.d` and `.e)`.
    expect(found).not.toContain(".e)");
  });

  test("collects only bare classes — never a variant", () => {
    // `dark:` compiles to `:where(.dark, .dark *)`, which adds no specificity:
    // it wins on ORDER alone, so it must keep the position Tailwind gave it.
    const css =
      "@layer utilities{.bg-x{background:red}.dark\\:bg-y:where(.dark,.dark *){background:blue}.a:hover{color:red}}";
    expect(unconditionalSelectors(css)).toEqual([".bg-x"]);
  });
});

describe("dropping what the runtime already declares", () => {
  const runtime = new Set([".px-2", ".hidden", ".p-4"]);

  test("drops the duplicate that cost the icon its padding", () => {
    const page = "@layer utilities{.px-2{padding-inline:.5rem}}";
    expect(dropRulesDeclaredBy(page, runtime)).toBe("");
  });

  test("keeps every responsive variant, duplicate or not", () => {
    // `.hidden` is the runtime's; `sm:block` is the page's and must stay LAST,
    // where a media query outranks it. This is the case the layer fix broke.
    const page =
      "@layer utilities{.hidden{display:none}@media (min-width:40rem){.sm\\:block{display:block}}}";
    const pruned = dropRulesDeclaredBy(page, runtime);
    expect(pruned).not.toContain(".hidden{");
    expect(pruned).toContain("@media (min-width:40rem)");
    expect(pruned).toContain(".sm\\:block");
  });

  test("keeps a class only the page uses", () => {
    const page = "@layer utilities{.gap-\\[7px\\]{gap:7px}}";
    expect(dropRulesDeclaredBy(page, runtime)).toContain(".gap-\\[7px\\]");
  });

  test("keeps a multi-selector rule unless EVERY selector is known", () => {
    // Dropping it would change what the surviving half matches.
    const page = "@layer utilities{.px-2,.mine{padding-inline:.5rem}}";
    expect(dropRulesDeclaredBy(page, runtime)).toContain(".mine");
  });

  test("leaves a layer that still holds something, removes one emptied", () => {
    const page =
      "@layer properties{.p-4{padding:1rem}}@layer utilities{.mine{color:red}}";
    const pruned = dropRulesDeclaredBy(page, runtime);
    expect(pruned).not.toContain("@layer properties");
    expect(pruned).toContain("@layer utilities{.mine{color:red}}");
  });

  test("is a no-op when the runtime declares nothing the page does", () => {
    const page = "@layer utilities{.a{color:red}.b{color:blue}}";
    expect(dropRulesDeclaredBy(page, new Set())).toBe(page);
  });

  test("sees the first block even behind the licence banner", () => {
    // Tailwind puts `/*! tailwindcss … */` in front of the first block of every
    // sheet. Folding that comment into the head made the block unrecognisable
    // as `@layer`, so the pruner walked past it — and on a small page the
    // utilities layer IS the first block, which exempted the whole file.
    const page = "/*! tailwindcss v4 */\n@layer utilities{.px-2{padding:1px}}";
    expect(dropRulesDeclaredBy(page, runtime)).not.toContain(".px-2");
  });
});

describe("the synced inventory", () => {
  test("is the runtime's, and holds the classes the defect turned on", async () => {
    const parsed: unknown = JSON.parse(
      await Bun.file(
        new URL(
          "../../src/services/pages/compile-assets/runtime-selectors.json",
          import.meta.url,
        ),
      ).text(),
    );
    const list: unknown = Reflect.get(Object(parsed), "selectors");
    const sha256: unknown = Reflect.get(Object(parsed), "sha256");
    expect(Array.isArray(list)).toBe(true);
    const selectors = new Set(
      (Array.isArray(list) ? list : []).filter(
        (entry): entry is string => typeof entry === "string",
      ),
    );
    // The pair that broke: both are the runtime's, so a page must declare
    // neither and their order stays the runtime's own.
    expect(selectors.has(".px-2")).toBe(true);
    expect(selectors.has(".ps-7")).toBe(true);
    // No variant of any kind is listed: a responsive one is not unconditional,
    // and a `dark:` one wins on order alone. Listing either would let the
    // compiler delete a rule whose position the page depends on. The test is
    // an UNESCAPED colon — `.\[--duration\:20s\]` is one class, not a variant.
    const unescaped = (selector: string): string =>
      selector.replaceAll(/\\./g, "");
    expect([...selectors].some((s) => unescaped(s).includes(":"))).toBe(false);
    expect(typeof sha256 === "string" ? sha256.length : 0).toBe(64);
  });
});
