import { describe, expect, test } from "bun:test";
import {
  componentsUsed,
  renderProjectManifest,
} from "../../../../src/services/page-project/manifest";

/**
 * The manifest is what an agent reads instead of re-reading its own project,
 * and — since the catalogue landed — also what says which components a page
 * actually reached for.
 *
 * That last line has three readers and none of them could see it before: the
 * builder, twenty steps in, deciding whether a region already has a component;
 * the build, warning about a contract-heavy component placed without its API;
 * and the critic, which judges pixels and could otherwise never say that a
 * screen of cards had a timeline available to it.
 */

const PAGE = `<script setup lang="ts">
import { useDeals } from "./composables/useDeals"
const { rows, status } = useDeals()
</script>

<template>
  <div class="p-6">
    <UPageHeader title="Deals" />
    <KpiStrip :rows="rows" />
    <UTable :data="rows" />
    <USlideover>
      <UButton label="Open" />
      <template #body><UBadge :label="status" /></template>
    </USlideover>
  </div>
</template>`;

describe("project manifest", () => {
  test("names the Nuxt UI components a file places", () => {
    const manifest = renderProjectManifest({ "Page.vue": PAGE });
    expect(manifest).toContain("uses:");
    for (const name of [
      "UBadge",
      "UButton",
      "UPageHeader",
      "USlideover",
      "UTable",
    ]) {
      expect(manifest).toContain(name);
    }
  });

  test("keeps the props and emits it already carried", () => {
    const manifest = renderProjectManifest({
      "components/KpiStrip.vue": `<script setup lang="ts">
defineProps<{ rows: Row[]; currency?: string }>()
defineEmits<{ select: [id: string] }>()
</script>
<template><UProgress /></template>`,
    });
    expect(manifest).toContain("props: rows, currency?");
    expect(manifest).toContain("emits: select");
    expect(manifest).toContain("uses: UProgress");
  });

  test("a file that places nothing says nothing about components", () => {
    const manifest = renderProjectManifest({
      "lib/format.ts": "export const money = (n: number) => `${n} €`",
    });
    expect(manifest).toContain("exports money");
    expect(manifest).not.toContain("uses:");
  });

  test("does not mistake what the script mentions for what the template places", () => {
    // A component named in a comment or a string is not on screen, and
    // counting it would make the build warn about an API nobody had to read.
    const manifest = renderProjectManifest({
      "components/Panel.vue": `<script setup lang="ts">
// USlideover was considered here and rejected
const label = "UTable"
</script>
<template><UCard /></template>`,
    });
    expect(manifest).toContain("uses: UCard");
    expect(manifest).not.toContain("USlideover");
    expect(manifest).not.toContain("UTable");
  });

  test("counts a component once however often it is placed", () => {
    expect(componentsUsed("<template><UCard /><UCard /></template>")).toEqual([
      "UCard",
    ]);
  });

  test("caps the list rather than turning a line into a file", () => {
    const many = Array.from(
      { length: 14 },
      (_unused, index) => `<UBadge${index.toString()} />`,
    ).join("");
    const manifest = renderProjectManifest({
      "Page.vue": `<template>${many}</template>`,
    });
    expect(manifest).toContain("…");
  });
});
