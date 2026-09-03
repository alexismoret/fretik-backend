import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The component reference corpus served by `pageDocs`.
 *
 * A page is real Vue over real Nuxt UI, so the agent needs the real API of the
 * components it is about to use — every prop, every slot. 117 components of
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

/**
 * `UBadge` / `badge` / `Badge` / `u-select-menu` → the corpus's own file
 * naming. Kebab case matters because templates may write either form, and the
 * contract check reads component names straight out of a template.
 */
const canonical = (name: string, known: string[]): string | undefined => {
  const bare = name
    .trim()
    .replace(/^[uU](?=[A-Z-])/, "")
    .replaceAll("-", "");
  return known.find(
    (candidate) => candidate.toLowerCase() === bare.toLowerCase(),
  );
};

/**
 * Where a reference stops being the CONTRACT and starts being illustration.
 *
 * Each generated file is `## API` (props, slots, emits) then `## Usage` and
 * `## Examples`. The API half is what a page cannot guess and must not get
 * wrong; the rest is prose about a library the model already knows. Measured
 * across the corpus, the API is 33% of the bytes — a six-component call drops
 * from ~32k tokens to ~12k, which is the difference between reading the docs
 * and drowning in them.
 *
 * Sliced at READ time rather than emitted as a second file by the sync script:
 * a derived artifact committed next to its source is one more thing that can
 * fall out of date, and this one cannot.
 */
const API_ENDS_AT = /\n## (?:Usage|Examples)\b/;

const apiDigest = (reference: string): string => {
  const cut = API_ENDS_AT.exec(reference);
  if (!cut) return reference;
  return `${reference.slice(0, cut.index).trimEnd()}\n\n> Usage notes and worked examples are omitted. Ask for this component again with \`full: true\` if the API alone leaves the question open.\n`;
};

export const readComponentDocs = async (
  names: string[],
  options?: { full?: boolean },
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
      ? [
          {
            component: `U${result.resolved}`,
            reference:
              options?.full === true
                ? result.reference
                : apiDigest(result.reference),
          },
        ]
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

/**
 * Slots whose meaning nobody gets wrong: the content, and what sits either side
 * of it. Everything outside this set is a component that expects its parts to
 * be placed by NAME — and placing them by intuition instead is how a compose
 * form ends up rendered permanently inline because it went into `UModal`'s
 * default slot, which is the TRIGGER. That defect shipped; so did a `UTable`
 * row handler written against a guessed signature. Both components declare
 * slots outside this set; `UButton`, `UBadge`, `UCard`, `UIcon`, `UProgress`
 * do not, and warning about those would only teach the agent to skim warnings.
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

/** Parsed once per component per process — the corpus is immutable at runtime. */
const contractHeavyCache = new Map<string, Promise<boolean>>();

const SLOTS_BLOCK_RE = /### Slots\s*```ts([\s\S]*?)```/;
const SLOT_NAME_RE = /^\s{2}([a-zA-Z][A-Za-z0-9:_-]*)\(/gm;

const isContractHeavy = async (resolved: string): Promise<boolean> => {
  const reference = await Bun.file(join(ASSETS_DIR, `${resolved}.md`))
    .text()
    .catch(() => null);
  if (reference === null) return false;
  const block = SLOTS_BLOCK_RE.exec(reference)?.[1];
  if (block === undefined) return false;
  return [...block.matchAll(SLOT_NAME_RE)].some(
    (match) => !OBVIOUS_SLOTS.has(match[1] ?? ""),
  );
};

/**
 * Of the components named, which ones expect their parts to be placed by name.
 * Unknown names are dropped — an unregistered component is a different problem,
 * already reported by the write's own sanitising pass.
 */
export const listContractHeavy = async (names: string[]): Promise<string[]> => {
  const index = await loadIndex().catch(() => null);
  if (index === null) return [];
  const known = Object.keys(index.components);

  const verdicts = await Promise.all(
    names.map(async (name) => {
      const resolved = canonical(name, known);
      if (resolved === undefined) return null;
      let heavy = contractHeavyCache.get(resolved);
      if (heavy === undefined) {
        heavy = isContractHeavy(resolved);
        contractHeavyCache.set(resolved, heavy);
      }
      return (await heavy) ? `U${resolved}` : null;
    }),
  );
  return [...new Set(verdicts.filter((name) => name !== null))];
};
