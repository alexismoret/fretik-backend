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
