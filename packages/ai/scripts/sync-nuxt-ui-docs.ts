/**
 * Regenerates the page runtime's component reference corpus.
 *
 * Pages are written by the agent in real Vue against real Nuxt UI, so the
 * agent needs the real component API — every prop, every slot, for 117
 * components. That does not fit in a skill, and it must not go stale: this
 * script rebuilds it from the library's own published corpus.
 *
 *   source  : https://ui.nuxt.com/llms-full.txt  (Nuxt UI docs, MIT)
 *   filter  : app/page-runtime/src/components.generated.ts — the components
 *             the runtime actually registers, so we never document a
 *             component that would render as an unknown element
 *   output  : src/tools/assets/nuxt-ui/<Component>.md + index.json
 *
 * Served by `pageDocs`, never bundled into the skill tree (117 files of
 * TypeScript interfaces would drown skill search) and never in the system
 * prompt — what IS in the prompt is `catalogue.json`, the one-line-per-
 * component choice list, which this script checks for coverage.
 *
 * Run after every `@nuxt/ui` upgrade, and always AFTER the runtime build:
 *   cd app && bun run page-runtime:build
 *   cd backend/packages/ai && bun scripts/sync-nuxt-ui-docs.ts
 * The order is load-bearing — this script filters on the generated component
 * list, so run first it silently omits everything the upgrade added.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://ui.nuxt.com/llms-full.txt";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "../src/tools/assets/nuxt-ui");
const RUNTIME_COMPONENTS = join(
  HERE,
  "../../../../app/page-runtime/src/components.generated.ts",
);

/**
 * Per-file line budget. The API block is never cut — it is the part the model
 * cannot guess — so the budget is spent on Usage first, then Examples.
 */
const USAGE_MAX_LINES = 220;
const EXAMPLES_MAX_LINES = 160;

/**
 * Registered as a side effect of their parent and never written in a template:
 * upstream documents no page for them, and requiring a catalogue line for
 * something an agent cannot use would be a line that teaches nothing.
 */
const INTERNAL_COMPONENTS = new Set([
  "ContextMenuContent",
  "DropdownMenuContent",
  "LinkBase",
]);

const section = (body: string, heading: string): string => {
  const match = body.match(
    new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  return match?.[1]?.trim() ?? "";
};

/** Cut at a fence boundary so a truncated file never ends mid-snippet. */
const clamp = (text: string, maxLines: number): string => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  let cut = maxLines;
  let fences = 0;
  for (let i = 0; i < cut; i++) {
    if (lines[i]?.startsWith("```")) fences++;
  }
  if (fences % 2 === 1) {
    while (cut < lines.length && !lines[cut]?.startsWith("```")) cut++;
    cut++;
  }
  return `${lines.slice(0, cut).join("\n")}\n\n_(truncated — ask for fewer components to see more, or rely on the API block above)_`;
};

/**
 * Slots whose meaning nobody gets wrong: the content, and what sits either
 * side of it. Everything else is a part the component expects to be placed by
 * NAME, and placing one by intuition is how a compose form ends up rendered
 * permanently inline because it went into the modal's default slot — which is
 * the TRIGGER. Kept in step with `page-component-docs.ts`.
 */
const OBVIOUS_SLOTS = new Set([
  "default",
  "leading",
  "trailing",
  "label",
  "icon",
  "header",
  "footer",
  "title",
  "description",
]);

const SLOTS_BLOCK_RE = /### Slots\s*```ts([\s\S]*?)```/;
const SLOT_NAME_RE = /^\s{2}([a-zA-Z][A-Za-z0-9:_-]*)\(/gm;

const slotNames = (api: string): string[] => {
  const block = SLOTS_BLOCK_RE.exec(api)?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(SLOT_NAME_RE)].map((match) => match[1] ?? "");
};

const VUE_FENCE_RE = /```vue[^\n]*\n([\s\S]*?)```/g;
const COMPOSITION_MAX_LINES = 26;

/**
 * One real example of the component ASSEMBLED — which part goes in which slot.
 *
 * A slot list gives the names and never which one supersedes which: `Slideover`
 * declares nine peers, and nothing in that interface says `default` is the
 * trigger while the panel is `#body`. shadcn found the same thing and answered
 * it by publishing composition trees, reporting that agents compose more
 * reliably when they can see the whole structure. Rather than hand-draw 117
 * trees that would drift, this lifts the shortest snippet the library's own
 * docs already ship that puts something in a NAMED slot — evidence, not
 * paraphrase — and puts it above the `## Usage` cut so it survives the digest
 * every `pageDocs` call returns by default.
 */
const TEMPLATE_SLOT_RE = /<template\s+#([a-zA-Z][A-Za-z0-9_-]*)/g;

const composition = (api: string, usage: string, examples: string): string => {
  const declared = slotNames(api);
  const named = declared.filter((slot) => !OBVIOUS_SLOTS.has(slot));

  /**
   * Slots the docs USE and the interface never declares.
   *
   * `UTable` is the whole reason this exists: its per-column `#<name>-cell`
   * slots are the way a table renders anything but a raw value, they appear
   * only inside a 335-line example that the line budget cuts, and the `### Slots`
   * interface lists six names, none of them a cell. An agent reading the digest
   * saw a table it could not format and rendered `[object Object]`.
   */
  const dynamic = [
    ...new Set(
      [usage, examples]
        .flatMap((source) => [...source.matchAll(TEMPLATE_SLOT_RE)])
        .map((match) => match[1] ?? "")
        .filter((slot) => slot.length > 0 && !declared.includes(slot)),
    ),
  ].slice(0, 6);

  if (named.length === 0 && dynamic.length === 0) return "";

  const candidates: string[] = [];
  for (const source of [usage, examples]) {
    for (const match of source.matchAll(VUE_FENCE_RE)) {
      const body = match[1];
      if (body === undefined) continue;
      const lines = body.trimEnd().split("\n");
      if (lines.length > COMPOSITION_MAX_LINES) continue;
      if (named.some((slot) => body.includes(`#${slot}`)))
        candidates.push(body);
    }
  }
  candidates.sort((a, b) => a.split("\n").length - b.split("\n").length);

  const parts: string[] = [];
  if (named.length > 0) {
    parts.push(
      `Parts placed by name: ${named.map((slot) => `\`#${slot}\``).join(", ")}.`,
    );
  }
  if (dynamic.length > 0) {
    parts.push(
      `Also written in the docs and absent from the interface above — one per column or item: ${dynamic
        .map((slot) => `\`#${slot}\``)
        .join(", ")}.`,
    );
  }
  const shortest = candidates[0];
  if (shortest !== undefined) {
    parts.push(`\`\`\`vue\n${shortest.trimEnd()}\n\`\`\``);
  }
  return parts.join("\n\n");
};

const registeredComponents = async (): Promise<Set<string>> => {
  const source = await Bun.file(RUNTIME_COMPONENTS).text();
  const names = new Set<string>();
  for (const match of source.matchAll(/\bU([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
};

/**
 * The catalogue is the half of the docs a human writes, and the half the
 * builder reads on every run. A component the runtime registers with no line
 * in it is a component the builder never learns exists — the exact failure the
 * catalogue was written to end — so this fails the sync rather than reporting
 * it, which is how the last upgrade's additions would have been noticed.
 */
const checkCatalogueCoverage = async (
  registered: Set<string>,
  documented: string[],
): Promise<void> => {
  const raw: unknown = await Bun.file(join(OUT_DIR, "catalogue.json")).json();
  const entries =
    typeof raw === "object" &&
    raw !== null &&
    "components" in raw &&
    typeof raw.components === "object" &&
    raw.components !== null
      ? raw.components
      : null;
  if (entries === null) {
    throw new Error(
      "[nuxt-ui-docs] catalogue.json is not a catalogue: expected { components }.",
    );
  }
  const listed = new Set(Object.keys(entries));

  const expected = documented.filter((name) => !INTERNAL_COMPONENTS.has(name));
  const missing = expected.filter((name) => !listed.has(name)).sort();
  const stale = [...listed].filter((name) => !registered.has(name)).sort();

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `no catalogue line (${missing.length.toString()}): ${missing.join(", ")}\n` +
        "  Write one in assets/nuxt-ui/catalogue.json: what it is, when it earns the screen,\n" +
        "  when it does not, and the prop or slot that unlocks it. A component with no line\n" +
        "  is a component the builder will never reach for.",
    );
  }
  if (stale.length > 0) {
    problems.push(
      `catalogued but no longer registered (${stale.length.toString()}): ${stale.join(", ")}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `[nuxt-ui-docs] catalogue is out of step —\n${problems.join("\n")}`,
    );
  }
  console.log(
    `[nuxt-ui-docs] catalogue covers ${listed.size.toString()} components`,
  );
};

const main = async (): Promise<void> => {
  const registered = await registeredComponents();
  if (registered.size < 50) {
    throw new Error(
      `Only ${registered.size.toString()} components parsed from ${RUNTIME_COMPONENTS} — the runtime file moved or changed shape.`,
    );
  }

  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`${SOURCE_URL} → HTTP ${response.status.toString()}`);
  }
  const corpus = await response.text();

  const documented: string[] = [];
  const skipped: string[] = [];
  let composed = 0;

  for (const part of corpus.split(/^# (?=\S)/m).slice(1)) {
    const breakAt = part.indexOf("\n");
    const name = part.slice(0, breakAt).trim();
    if (!registered.has(name)) continue;

    const body = part.slice(breakAt + 1);
    const api = section(body, "API");
    const usage = section(body, "Usage");
    const examples = section(body, "Examples");
    if (api.length === 0 && usage.length === 0) {
      skipped.push(name);
      continue;
    }

    const parts = composition(api, usage, examples);
    if (parts.length > 0) composed++;

    const file = [
      `# U${name}`,
      "",
      "> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.",
      "",
      api.length > 0 ? `## API\n\n${api}` : "",
      parts.length > 0 ? `## Composition\n\n${parts}` : "",
      usage.length > 0 ? `## Usage\n\n${clamp(usage, USAGE_MAX_LINES)}` : "",
      examples.length > 0
        ? `## Examples\n\n${clamp(examples, EXAMPLES_MAX_LINES)}`
        : "",
    ]
      .filter((block) => block.length > 0)
      .join("\n\n");

    await Bun.write(join(OUT_DIR, `${name}.md`), `${file}\n`);
    documented.push(name);
  }

  // Names only. The one-line summaries this file used to carry were lifted
  // from the first prose line of Usage ("Use the `title` prop to set the
  // title of the Alert."), nothing ever read them, and the question they
  // pretended to answer — which component do I want — is catalogue.json's.
  await Bun.write(
    join(OUT_DIR, "index.json"),
    `${JSON.stringify(
      {
        source: SOURCE_URL,
        generatedFrom: "llms-full.txt",
        components: documented.sort(),
      },
      null,
      2,
    )}\n`,
  );

  const undocumented = [...registered]
    .filter(
      (name) => !documented.includes(name) && !INTERNAL_COMPONENTS.has(name),
    )
    .sort();

  console.log(
    `[nuxt-ui-docs] ${documented.length.toString()} components written to ${OUT_DIR} (${composed.toString()} with a composition block)`,
  );
  if (skipped.length > 0)
    console.log(`[nuxt-ui-docs] no API/Usage section: ${skipped.join(", ")}`);
  if (undocumented.length > 0) {
    console.log(
      `[nuxt-ui-docs] registered but undocumented (${undocumented.length.toString()}): ${undocumented.join(", ")}`,
    );
  }

  await checkCatalogueCoverage(registered, documented);
};

await main();
