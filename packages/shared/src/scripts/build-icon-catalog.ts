/**
 * Build the curated Lucide icon catalog used by the object-type / select-option
 * icon pickers and the chatbot `searchIcons` tool.
 *
 * Lucide ships ~1630 icons; that is too many to surface to users or the agent.
 * This script fetches every icon's metadata (name + `tags` + `categories`) and
 * curates a business-relevant subset (~450) covering all common domains, writing
 * `src/lib/icons/catalog.ts`. The `tags` are Lucide's own synonyms (truck →
 * delivery/van/shipping/lorry) — the search layer ranks on them, so we never
 * hand-author synonyms.
 *
 * Run: `bun run src/scripts/build-icon-catalog.ts` (re-run when Lucide updates).
 * Set `ICON_CACHE=<path>` to a JSON array of `{name,tags,categories}` to skip the
 * ~1600 network fetches during local iteration.
 */
import { z } from "zod";
import { ICON_ESSENTIALS } from "./icon-essentials";

const META = "https://icones.js.org/collections/lucide-meta.json";
const RAW = (n: string) =>
  `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${n}.json`;
const OUT = new URL("../lib/icons/catalog.ts", import.meta.url).pathname;
// The frontend Nuxt SPA can't import this backend package (it pulls in
// drizzle/aws-sdk/e2b), so the icon picker mirrors the SAME curated set via a
// generated JSON (name + tags) it imports directly. One script, both sides.
const FRONTEND_OUT = new URL(
  "../../../../../app/app/app/utils/collectionIconCatalog.json",
  import.meta.url,
).pathname;
const MAX_TOTAL = 480;

const iconMetaSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
});
type IconMeta = z.infer<typeof iconMetaSchema>;

const collectionSchema = z.object({ icons: z.array(z.string()) });
const perIconSchema = z.object({
  tags: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
});

/**
 * Per-category cap. Business/domain categories get a generous budget; UI-noise
 * categories (arrows, layout, cursors, math, code) get little or none — the few
 * genuinely useful ones come in through `ICON_ESSENTIALS`. Categories absent
 * here contribute 0.
 */
const CATEGORY_BUDGET: Record<string, number> = {
  finance: 32,
  account: 26,
  buildings: 24,
  transportation: 32,
  "food-beverage": 30,
  travel: 26,
  tools: 26,
  home: 26,
  time: 24,
  medical: 26,
  security: 20,
  communication: 22,
  mail: 18,
  shopping: 27,
  charts: 20,
  science: 20,
  nature: 21,
  animals: 23,
  sustainability: 23,
  weather: 22,
  sports: 12,
  people: 3,
  seasons: 5,
  notifications: 16,
  navigation: 16,
  connectivity: 12,
  devices: 24,
  multimedia: 16,
  photography: 8,
  shapes: 14,
  accessibility: 8,
  social: 14,
  files: 22,
  text: 10,
  development: 6,
  design: 5,
  layout: 5,
  arrows: 4,
  math: 3,
  gaming: 5,
};

const loadAll = async (): Promise<IconMeta[]> => {
  const cache = process.env.ICON_CACHE;
  if (cache) {
    return z
      .array(iconMetaSchema)
      .parse(JSON.parse(await Bun.file(cache).text()));
  }
  const meta = collectionSchema.parse(await (await fetch(META)).json());
  const names = meta.icons;
  const out: IconMeta[] = [];
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < names.length) {
      const name = names[i++];
      if (!name) continue;
      try {
        const res = await fetch(RAW(name));
        if (!res.ok) continue; // alias → 404
        const j = perIconSchema.parse(await res.json());
        out.push({
          name,
          tags: j.tags ?? [],
          categories: j.categories ?? [],
        });
      } catch {
        // transient — skip; re-run if the count looks low.
      }
    }
  };
  await Promise.all(Array.from({ length: 30 }, worker));
  return out;
};

/** Rank within a category: base icons (fewer hyphens, shorter) first; well-tagged ones rank up. */
const score = (e: IconMeta): number =>
  -(e.name.split("-").length - 1) * 2 -
  e.name.length * 0.02 +
  Math.min(e.tags.length, 8) * 0.2;

const all = await loadAll();
console.log(`loaded ${all.length} canonical icons`);
const byName = new Map(all.map((e) => [e.name, e]));

const kept = new Set<string>();
// 1. Essentials always in (status + generic business glyphs).
for (const name of ICON_ESSENTIALS) {
  if (byName.has(name)) kept.add(name);
  else console.warn(`essential icon not in Lucide: ${name}`);
}

// 2. Fill each budgeted category with its top-scoring icons.
const byCategory = new Map<string, IconMeta[]>();
for (const e of all)
  for (const c of e.categories) {
    const list = byCategory.get(c) ?? [];
    list.push(e);
    byCategory.set(c, list);
  }
// Essentials are already kept and counted; category fills top up to MAX_TOTAL
// without ever evicting them (the cap is enforced here, not by a later slice).
for (const [cat, budget] of Object.entries(CATEGORY_BUDGET)) {
  if (kept.size >= MAX_TOTAL) break;
  const pool = (byCategory.get(cat) ?? []).sort((a, b) => score(b) - score(a));
  let added = 0;
  for (const e of pool) {
    if (added >= budget || kept.size >= MAX_TOTAL) break;
    if (kept.has(e.name)) continue;
    kept.add(e.name);
    added++;
  }
}

const final = [...kept]
  .map((n) => byName.get(n))
  .filter((e): e is IconMeta => e !== undefined)
  .sort((a, b) => a.name.localeCompare(b.name));

const header = `// AUTO-GENERATED by src/scripts/build-icon-catalog.ts — do not edit by hand.
// Source: Lucide icons (ISC license). Run \`bun run src/scripts/build-icon-catalog.ts\` to refresh.
// ${final.length} curated icons (names are bare Lucide kebab; the UI adds the \`i-lucide-\` prefix).

export interface IconEntry {
  /** Bare Lucide name, e.g. "truck". Render with the \`i-lucide-\` prefix. */
  name: string;
  /** Lucide's own synonyms — the search layer ranks on these. */
  tags: string[];
  /** Lucide categories, e.g. ["transportation"]. */
  categories: string[];
}

export const ICON_CATALOG: readonly IconEntry[] = `;

await Bun.write(OUT, header + JSON.stringify(final, null, 2) + ";\n");
console.log(`wrote ${final.length} icons → ${OUT}`);

// Frontend mirror — name + tags only (the picker ranks on tags exactly like the
// agent's searchIcons). JSON, so it stays out of the frontend's ESLint style.
const frontend = final.map((e) => ({ name: e.name, tags: e.tags }));
await Bun.write(FRONTEND_OUT, JSON.stringify(frontend, null, 2) + "\n");
console.log(`wrote ${frontend.length} icons → ${FRONTEND_OUT}`);
