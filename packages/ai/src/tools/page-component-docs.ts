import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The component reference corpus served by `managePage { action: "components" }`.
 *
 * A page is real Vue over real Nuxt UI, so the agent needs the real API of the
 * components it is about to use — every prop, every slot. 109 components of
 * that do not fit in a skill and must not be paraphrased into staleness, so
 * they are generated from the library's own published docs
 * (`scripts/sync-nuxt-ui-docs.ts`, re-run on every `@nuxt/ui` upgrade) and
 * served by name, on demand.
 *
 * This is the same split the library itself recommends: the skill carries the
 * JUDGMENT (which component, which layout, which density), the lookup carries
 * the API surface. Neither is in the system prompt.
 */

const ASSETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "assets/nuxt-ui",
);

/** Per-call ceiling. Six components is a whole page's palette; beyond that the
 * agent is browsing, not building, and the turn drowns in interface dumps. */
export const MAX_COMPONENT_DOCS = 6;

type ComponentIndex = { components: Record<string, string> };

let indexPromise: Promise<ComponentIndex> | null = null;

const loadIndex = (): Promise<ComponentIndex> => {
  indexPromise ??= Bun.file(join(ASSETS_DIR, "index.json")).json();
  return indexPromise;
};

/** `UBadge` / `badge` / `Badge` → `Badge`, the corpus's own file naming. */
const canonical = (name: string, known: string[]): string | undefined => {
  const bare = name.trim().replace(/^U(?=[A-Z])/, "");
  return known.find(
    (candidate) => candidate.toLowerCase() === bare.toLowerCase(),
  );
};

export const readComponentDocs = async (
  names: string[],
): Promise<
  | { docs: { component: string; reference: string }[]; unknown: string[] }
  | { error: string }
> => {
  const index = await loadIndex().catch(() => null);
  if (index === null) {
    return {
      error:
        "The component reference corpus is missing on this server — write the page from the patterns in skills/building-pages and the API you know.",
    };
  }

  const known = Object.keys(index.components);
  const requested = names.slice(0, MAX_COMPONENT_DOCS);

  const results = await Promise.all(
    requested.map(async (name) => {
      const resolved = canonical(name, known);
      if (resolved === undefined) return { name, reference: null };
      const reference = await Bun.file(join(ASSETS_DIR, `${resolved}.md`))
        .text()
        .catch(() => null);
      return { name, resolved, reference };
    }),
  );

  const docs = results.flatMap((result) =>
    result.reference !== null && result.resolved !== undefined
      ? [{ component: `U${result.resolved}`, reference: result.reference }]
      : [],
  );
  const unknown = results
    .filter((result) => result.reference === null)
    .map((result) => result.name);

  return { docs, unknown };
};

/** Every component the page runtime registers — the answer to "what may I use". */
export const listComponentNames = async (): Promise<string[]> => {
  const index = await loadIndex().catch(() => null);
  return index === null
    ? []
    : Object.keys(index.components).map((name) => `U${name}`);
};
