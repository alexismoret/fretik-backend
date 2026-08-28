import { describe, expect, test } from "bun:test";
import { autofixPageSource } from "../../src/services/pages/autofix";

/**
 * The repairs that need no model, and — more importantly — the ones that must
 * NOT happen. An autofixer that guesses is worse than none: it would rewrite
 * working code behind the agent's back, and its next edit anchors would miss.
 */

const sfc = (script: string, template = "<div>hi</div>") =>
  `<template>${template}</template>\n<script setup lang="ts">\n${script}\n</script>\n`;

describe("missing imports", () => {
  test("injects the vue composables a page used but never imported", () => {
    const result = autofixPageSource(
      sfc(
        `const rows = ref([]);\nconst n = computed(() => rows.value.length);`,
      ),
    );
    expect(result.source).toContain('from "vue"');
    expect(result.source).toMatch(/import \{[^}]*\bref\b/);
    expect(result.source).toMatch(/import \{[^}]*\bcomputed\b/);
    expect(result.autofixes).toHaveLength(1);
  });

  test("extends an existing vue import instead of adding a second one", () => {
    const result = autofixPageSource(
      sfc(`import { ref } from "vue";\nconst n = computed(() => 1);`),
    );
    expect(result.source.match(/from "vue"/g)).toHaveLength(1);
    expect(result.source).toMatch(/import \{[^}]*computed[^}]*\} from "vue"/);
  });

  test("leaves a page alone when everything is already imported", () => {
    const source = sfc(
      `import { ref, computed } from "vue";\nconst r = ref(1);\nconst c = computed(() => r.value);`,
    );
    const result = autofixPageSource(source);
    expect(result.source).toBe(source);
    expect(result.autofixes).toHaveLength(0);
  });

  test("never shadows a symbol the page defined itself", () => {
    // A page that wrote its own `watch` helper must keep it — importing Vue's
    // over the top would change what the code means.
    const source = sfc(
      `const watch = (fn: () => void) => fn();\nwatch(() => {});`,
    );
    expect(autofixPageSource(source).source).toBe(source);
  });

  test("adds useToast from @nuxt/ui, not from vue", () => {
    const result = autofixPageSource(sfc(`const toast = useToast();`));
    expect(result.source).toMatch(/import \{ useToast \} from "@nuxt\/ui"/);
    expect(result.source).not.toContain('from "vue"');
  });

  test("does nothing to a file the compiler will refuse anyway", () => {
    // Two script blocks is a structure error; repairing inside one of them
    // would only make the compiler's message harder to place.
    const source = `<template><div /></template>\n<script setup>const a = ref(1)</script>\n<script setup>const b = ref(2)</script>`;
    expect(autofixPageSource(source).source).toBe(source);
  });

  test("does not import compiler macros", () => {
    const source = sfc(`const props = defineProps<{ a: string }>();`);
    expect(autofixPageSource(source).source).toBe(source);
  });
});

describe("icon names are left alone", () => {
  test("never touches an icon, however unfamiliar the name looks", () => {
    // The page runtime bundles the WHOLE Lucide set (1817 icons + 217
    // aliases); `lib/icons/search` is a 480-entry curated list behind the
    // picker and the search tool. Validating page source against the curated
    // list flagged 11 of 24 real pages, and every flag was false —
    // `filter-x`, `folder-lock` and `pie-chart` all render, `alert-triangle`
    // is a live alias. This test exists so nobody rebuilds that fixer.
    const source = sfc(
      ``,
      `<UIcon name="i-lucide-filter-x" /><UIcon name="i-lucide-alert-triangle" /><UIcon name="i-lucide-folder-lock" />`,
    );
    const result = autofixPageSource(source);
    expect(result.source).toBe(source);
    expect(result.autofixes).toHaveLength(0);
  });
});

/**
 * Measured on 2026-08-28: a model writing a long page sprayed U+0301 through
 * its own code. Every compile refused with `Unexpected character`, and because
 * a combining mark draws itself onto the character BEFORE it, the agent could
 * not see it in any text it was able to read — it spent seven calls editing a
 * line that looked correct. There is one right answer for these, so they never
 * reach the compiler.
 *
 * Every invisible character below is written as an escape on purpose: pasted
 * literally they are unreviewable, which is the whole point of the defect.
 */
describe("invisible characters", () => {
  const COMBINING_ACUTE = "́";
  const ZERO_WIDTH_SPACE = "​";
  const BIDI_OVERRIDE = "\u202E";

  test("strips a combining mark the model dropped into code", () => {
    const source = sfc(`const n = (a * ${COMBINING_ACUTE}31) + 0;`);
    const result = autofixPageSource(source);
    expect(result.source).not.toContain(COMBINING_ACUTE);
    expect(result.source).toContain("const n = (a * 31) + 0;");
    expect(result.autofixes).toHaveLength(1);
    expect(result.autofixes[0]?.message).toContain("U+0301");
  });

  test("strips zero-width and bidi controls", () => {
    const result = autofixPageSource(
      sfc(`const a${ZERO_WIDTH_SPACE} = 1;${BIDI_OVERRIDE}const b = 2;`),
    );
    expect(result.source).toContain("const a = 1;const b = 2;");
    expect(result.autofixes[0]?.message).toContain("U+200B");
    expect(result.autofixes[0]?.message).toContain("U+202E");
  });

  test("leaves real accented text alone, composed or decomposed", () => {
    // The sweep is for ORPHAN marks — one following a letter is how `é` is
    // legitimately written in decomposed form. Stripping those would silently
    // rewrite a page's French labels into `Recu` and `Expedition`.
    const composed = sfc(``, `<p>Reçu · Expédition · Créé</p>`);
    expect(autofixPageSource(composed).source).toBe(composed);

    // Byte-identical, deliberately: the sweep only removes what it names. It
    // does NOT normalise, or removing one stray mark elsewhere in the file
    // would silently recompose every accent in the page and break the anchors
    // of the agent's next edit.
    const decomposed = sfc(
      ``,
      `<p>Cre${COMBINING_ACUTE}e${COMBINING_ACUTE}</p>`,
    );
    const result = autofixPageSource(decomposed);
    expect(result.source).toBe(decomposed);
    expect(result.autofixes).toHaveLength(0);
  });
});
