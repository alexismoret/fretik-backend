import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every component the page runtime registers, on one line each, in the
 * builder's prompt.
 *
 * The corpus next to this file answers "how does UTable work". Nothing
 * answered "what else was there", and it showed: measured across ten generated
 * pages, seventeen components out of a hundred and seventeen — a table, a
 * slideover, a select, a skeleton, an empty state and icons — carried every
 * screen. No avatars on people, no timeline on dated events, no tabs. The
 * catalogue was not the constraint; reaching for the first component that
 * would work was, and the first component that comes to mind is whichever one
 * the prose named most often.
 *
 * So the prose stopped naming any of them. `references/components.md` used to
 * be eight "need → component" tables where two entries said "the default" and
 * seventy said nothing at all; this file replaces those tables with a flat
 * list where every component gets the same shape — what it is, when it earns
 * the screen, when it does not, and the one prop or slot that unlocks it.
 *
 * It lives in the prompt rather than behind a tool call for the same reason
 * the design doctrine does: a page is designed on every single run, and a
 * catalogue that must be fetched is a catalogue the model decides it can skip.
 * Read once at module load, byte-stable, cached.
 *
 * Exclusions are TECHNICAL. A component is struck out here only when the page
 * frame cannot run it — it double-mounts, it persists through a cookie or
 * localStorage the sandbox has none of, or it answers hooks that belong to the
 * app shell. Taste is the builder's, and it needs the whole list to exercise
 * it.
 */

const CATALOGUE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "assets/nuxt-ui/catalogue.json",
);

interface CatalogueEntry {
  job: string;
  what?: string;
  when?: string;
  not?: string;
  distinctive?: string;
  why?: string;
}

interface Catalogue {
  jobs: Record<string, string>;
  components: Record<string, CatalogueEntry>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Validated rather than trusted, because the failure is silent otherwise: a
 * malformed file would render an empty section, the prompt would still
 * assemble, and every page after it would be designed out of whatever
 * components the model remembers. Boot loudly instead.
 */
const parseCatalogue = (raw: unknown): Catalogue => {
  if (!isRecord(raw) || !isRecord(raw.jobs) || !isRecord(raw.components)) {
    throw new Error(
      `${CATALOGUE_PATH} is not a catalogue: expected { jobs, components }.`,
    );
  }

  const jobs: Record<string, string> = {};
  for (const [key, label] of Object.entries(raw.jobs)) {
    jobs[key] = text(label) ?? key;
  }

  const components: Record<string, CatalogueEntry> = {};
  for (const [name, entry] of Object.entries(raw.components)) {
    if (!isRecord(entry)) {
      throw new Error(`${CATALOGUE_PATH}: ${name} is not an object.`);
    }
    const job = text(entry.job);
    if (job === undefined) {
      throw new Error(`${CATALOGUE_PATH}: ${name} has no job.`);
    }
    components[name] = {
      job,
      ...(text(entry.what) !== undefined ? { what: text(entry.what) } : {}),
      ...(text(entry.when) !== undefined ? { when: text(entry.when) } : {}),
      ...(text(entry.not) !== undefined ? { not: text(entry.not) } : {}),
      ...(text(entry.distinctive) !== undefined
        ? { distinctive: text(entry.distinctive) }
        : {}),
      ...(text(entry.why) !== undefined ? { why: text(entry.why) } : {}),
    };
  }

  return { jobs, components };
};

/**
 * Read once at module load, exactly like the design doctrine. The prompt is
 * assembled per turn but its bytes are constant — a prefix that varies is a
 * prefix that never hits the cache.
 */
const CATALOGUE: Catalogue = parseCatalogue(
  await Bun.file(CATALOGUE_PATH).json(),
);

/** The order groups appear in, which is the order a screen is decided in. */
const JOB_ORDER = [
  "structure",
  "navigation",
  "records",
  "value",
  "input",
  "overlay",
  "feedback",
  "content",
  "excluded",
] as const;

const line = (name: string, entry: CatalogueEntry): string => {
  if (entry.job === "excluded") {
    return `- \`U${name}\` — ${entry.why ?? "not available in a page."}`;
  }
  const parts = [`- \`U${name}\` — ${entry.what ?? ""}`];
  if (entry.when !== undefined) parts.push(`when: ${entry.when}`);
  if (entry.not !== undefined) parts.push(`not: ${entry.not}`);
  if (entry.distinctive !== undefined) parts.push(entry.distinctive);
  return parts.join(" · ");
};

/**
 * The catalogue as markdown, grouped by job.
 *
 * Names only — no props beyond the one that distinguishes the component, and
 * no examples. `pageDocs` carries the API of the six or eight a page actually
 * uses; this is the list they are chosen FROM.
 */
export const renderComponentCatalogue = (): string => {
  const byJob = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(CATALOGUE.components)) {
    const bucket = byJob.get(entry.job) ?? [];
    bucket.push(line(name, entry));
    byJob.set(entry.job, bucket);
  }

  const sections = JOB_ORDER.flatMap((job) => {
    const lines = byJob.get(job);
    if (lines === undefined || lines.length === 0) return [];
    return [`## ${job} — ${CATALOGUE.jobs[job] ?? ""}\n\n${lines.join("\n")}`];
  });

  return [
    "Every component the page runtime registers. All of them are global — write `<UBadge>`, never an import. This list is what a page is composed FROM; `pageDocs` gives the API of the ones you settle on.",
    ...sections,
  ].join("\n\n");
};

/** The names the catalogue covers — the sync script's coverage check reads it. */
export const catalogueComponentNames = (): string[] =>
  Object.keys(CATALOGUE.components);
