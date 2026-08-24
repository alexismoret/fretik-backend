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
 * Served by `managePage { action: "components" }`, never bundled into the
 * skill tree (141 files of TypeScript interfaces would drown skill search)
 * and never in the system prompt.
 *
 * Run after every `@nuxt/ui` upgrade:  bun scripts/sync-nuxt-ui-docs.ts
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

const registeredComponents = async (): Promise<Set<string>> => {
  const source = await Bun.file(RUNTIME_COMPONENTS).text();
  const names = new Set<string>();
  for (const match of source.matchAll(/\bU([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
};

const main = async (): Promise<void> => {
  const registered = await registeredComponents();
  if (registered.size < 50) {
    throw new Error(
      `Only ${registered.size} components parsed from ${RUNTIME_COMPONENTS} — the runtime file moved or changed shape.`,
    );
  }

  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`${SOURCE_URL} → HTTP ${response.status}`);
  }
  const corpus = await response.text();

  const index: Record<string, string> = {};
  let written = 0;
  let skipped: string[] = [];

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

    // The first prose line of Usage is the component's own one-line purpose.
    const summary =
      usage
        .split("\n")
        .find(
          (line) =>
            line.trim().length > 0 &&
            !line.startsWith("#") &&
            !line.startsWith("```"),
        )
        ?.trim() ?? "";

    const file = [
      `# U${name}`,
      "",
      "> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.",
      "",
      api.length > 0 ? `## API\n\n${api}` : "",
      usage.length > 0 ? `## Usage\n\n${clamp(usage, USAGE_MAX_LINES)}` : "",
      examples.length > 0
        ? `## Examples\n\n${clamp(examples, EXAMPLES_MAX_LINES)}`
        : "",
    ]
      .filter((block) => block.length > 0)
      .join("\n\n");

    await Bun.write(join(OUT_DIR, `${name}.md`), `${file}\n`);
    index[name] = summary;
    written++;
  }

  await Bun.write(
    join(OUT_DIR, "index.json"),
    `${JSON.stringify({ source: SOURCE_URL, generatedFrom: "llms-full.txt", components: index }, null, 2)}\n`,
  );

  const missing = [...registered]
    .filter((name) => index[name] === undefined)
    .sort();
  console.log(`[nuxt-ui-docs] ${written} components written to ${OUT_DIR}`);
  if (skipped.length > 0)
    console.log(`[nuxt-ui-docs] no API/Usage section: ${skipped.join(", ")}`);
  if (missing.length > 0) {
    console.log(
      `[nuxt-ui-docs] registered but undocumented (${missing.length}): ${missing.join(", ")}`,
    );
  }
};

await main();
