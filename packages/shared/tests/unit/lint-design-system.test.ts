import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import {
  lintRawPalette,
  lintStacking,
} from "../../src/services/pages/lint/design-system";

/**
 * The palette and the layer stack — the two things a page inherits from the app
 * and cannot renegotiate.
 *
 * Every case below is a shape three separately-built pages produced on
 * 2026-09-04 against a doctrine that forbids it verbatim in the builder's own
 * system prompt. So what is pinned is not "the regex matches" but the two
 * properties that make a lint safe to gate on: it FIRES on the measured defect,
 * and it stays SILENT on the legitimate shape it most resembles.
 */

const sfc = (template: string): string =>
  ["<template>", `  ${template}`, "</template>"].join("\n");

describe("raw palette", () => {
  test("a lookup of hand-picked classes is one finding, not one per class", () => {
    // The measured shape: a page's own map from a value to a class string. One
    // page carried 57 of these in a single file, which as 57 findings is a wall
    // rather than an instruction — and untrue about the work, since the repair
    // is one edit.
    const source = [
      "export const STATUS = {",
      "  todo: { badge: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300' },",
      "  blocked: { badge: 'bg-red-500/10 text-red-600 dark:text-red-400' },",
      "  done: { badge: 'bg-emerald-500/10 text-emerald-600' },",
      "};",
    ].join("\n");

    const findings = lintRawPalette("lib/format.ts", source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocking");
    expect(findings[0]?.rule).toBe("raw-palette");
    // The count is the argument: it says how much of the file is hand-coloured.
    expect(findings[0]?.message).toContain("8 hand-picked colours");
    // And it points at the first one, so `pageRead` opens in the right place.
    expect(findings[0]?.line).toBe(2);
  });

  test("the themed scales are the page's own palette and stay silent", () => {
    // Nuxt UI aliases these onto the team's colours, so they move with the
    // theme. Flagging them would push pages AWAY from the design system.
    const source = sfc(
      '<div class="bg-primary-500 text-neutral-600 border-error-500 ring-success-400 text-warning-700" />',
    );
    expect(lintRawPalette("Page.vue", source)).toEqual([]);
  });

  test("a schema colour bound as a variable is the prescribed shape", () => {
    // `data.md` says a palette name cannot become a class — bind the variable.
    // This is what the rule is asking FOR, and it must never trip it.
    const source = [
      "const swatch = (color?: string | null) => ({",
      '  fg: `var(--color-${color ?? "zinc"}-500)`,',
      '  bg: `color-mix(in oklab, var(--color-${color ?? "zinc"}-500) 14%, transparent)`,',
      "});",
    ].join("\n");
    expect(lintRawPalette("lib/colors.ts", source)).toEqual([]);
  });

  test("semantic tokens are not hues and stay silent", () => {
    const source = sfc(
      '<div class="bg-elevated text-muted border-default text-highlighted text-dimmed" />',
    );
    expect(lintRawPalette("Page.vue", source)).toEqual([]);
  });
});

describe("stacking", () => {
  test("an overlay built by hand is named, with the components that replace it", () => {
    // Measured in the browser: a drawer built this way opened UNDERNEATH the
    // page's own sticky header, which blurred it through its backdrop-filter.
    const source = sfc(
      '<div v-if="open" class="fixed inset-0 z-50 flex justify-end"><div class="w-96" /></div>',
    );
    const findings = lintStacking("components/Drawer.vue", source);
    const overlay = findings.filter(
      (finding) => finding.rule === "hand-rolled-overlay",
    );
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.severity).toBe("blocking");
    expect(overlay[0]?.message).toContain("USlideover");
  });

  test("a page reaching into the overlay layer is refused at the ceiling", () => {
    const findings = lintStacking(
      "Page.vue",
      sfc('<header class="sticky top-0 z-50 backdrop-blur-sm" />'),
    );
    expect(findings.map((finding) => finding.rule)).toContain("page-z-ceiling");
  });

  test("ordinary sticky chrome is composition, not a violation", () => {
    // The rule is a ceiling, not a ban: sticky headers, floating bars and
    // layered cards are how pages are built, and flagging them would make the
    // lint the thing that ruins the layout.
    const source = sfc(
      '<div><header class="sticky top-0 z-10" /><div class="sticky top-0 z-20" /><div class="absolute inset-0" /></div>',
    );
    expect(lintStacking("Page.vue", source)).toEqual([]);
  });

  test("a component managing its own layers is the library's business", () => {
    const source = sfc(
      '<USlideover><div class="fixed inset-0 z-50" /></USlideover>',
    );
    const overlay = lintStacking("components/Panel.vue", source).filter(
      (finding) => finding.rule === "hand-rolled-overlay",
    );
    // The inner div is a plain box and still flagged; what must not be flagged
    // is the component itself.
    expect(overlay.every((finding) => finding.line > 0)).toBe(true);
    expect(lintStacking("components/Panel.vue", sfc("<USlideover />"))).toEqual(
      [],
    );
  });
});
