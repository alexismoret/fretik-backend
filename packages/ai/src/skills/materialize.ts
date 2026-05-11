import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteSkillFileVectors,
  listIndexedSkillFiles,
  vectorizeSkillFile,
} from "../services/vectorize/skills";

/**
 * Bundled-skills catalog loader.
 *
 * The skill bundles ship as package sources under
 * `src/skills/bundled/<name>/` (each folder holds a `SKILL.md` plus
 * optional `scripts/` and `references/` subtrees). The Python source
 * stays in the package; the bundles themselves are pushed to the
 * conversation sandbox at first init by `lib/conversation-storage.ts`
 * — a lightweight per-sandbox copy that the agent reads via
 * `read("skills/<name>/SKILL.md")` and imports via
 * `from skill_loader import load_skill; load_skill("<name>")`.
 *
 * What we need at boot is the **catalog** (skill name + description
 * from the SKILL.md frontmatter) so the system prompt can advertise
 * the L1 listing.
 */

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SRC_DIR = resolve(__dirname, "bundled");

let cachedCatalog: SkillCatalogEntry[] | null = null;

const parseFrontmatter = (
  body: string,
): { description: string; name?: string } => {
  // Minimal YAML front-matter parser — we only read scalar values from
  // the name/description keys. Keeps the implementation free of an
  // extra dep for a format we fully control.
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: "" };
  const raw = match[1] ?? "";
  const result: { description: string; name?: string } = { description: "" };
  for (const line of raw.split("\n")) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (value === undefined) continue;
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    if (key === "description") result.description = trimmed;
    if (key === "name") result.name = trimmed;
  }
  return result;
};

/**
 * Walk the bundled source tree once and produce the catalog
 * (skill name + description) consumed by the system-prompt renderer.
 *
 * Idempotent + cached at module level — bundled skills don't change
 * at runtime. Safe to call multiple times.
 */
export const loadSkillCatalog = async (): Promise<SkillCatalogEntry[]> => {
  if (cachedCatalog) return cachedCatalog;

  const entries: SkillCatalogEntry[] = [];

  let topLevel: string[];
  try {
    topLevel = await readdir(BUNDLED_SRC_DIR);
  } catch (err) {
    console.warn(
      `[skills] bundled source directory missing at ${BUNDLED_SRC_DIR}:`,
      err instanceof Error ? err.message : err,
    );
    cachedCatalog = [];
    return cachedCatalog;
  }

  await Promise.all(
    topLevel.map(async (child) => {
      if (child.startsWith(".")) return;
      const srcPath = join(BUNDLED_SRC_DIR, child);
      const info = await stat(srcPath).catch(() => null);
      if (!info?.isDirectory()) return;

      const skillMdPath = join(srcPath, "SKILL.md");
      const skillMdFile = Bun.file(skillMdPath);
      if (!(await skillMdFile.exists())) {
        console.warn(
          `[skills] skipping ${child}: no SKILL.md at ${skillMdPath}`,
        );
        return;
      }
      const body = await skillMdFile.text();
      const { description, name } = parseFrontmatter(body);
      if (!description) {
        console.warn(
          `[skills] skipping ${child}: SKILL.md missing description in frontmatter`,
        );
        return;
      }
      entries.push({ name: name ?? child, description });
    }),
  );

  entries.sort((a, b) => a.name.localeCompare(b.name));
  cachedCatalog = entries;
  return entries;
};

/**
 * Synchronous read-only accessor for the in-memory catalog. Returns
 * an empty array until `loadSkillCatalog()` has run at least once.
 */
export const getSkillCatalog = (): SkillCatalogEntry[] => cachedCatalog ?? [];

/**
 * Bundled skill file (SKILL.md or one of its `references/*.md`)
 * gathered for boot-time vectorisation.
 */
interface BundledSkillFile {
  skillName: string;
  /** "SKILL.md" or "references/foo.md" — relative to the skill folder. */
  skillFile: string;
  description: string;
  content: string;
}

const REFERENCES_SUBDIR = "references";

const readSkillFiles = async (
  skillName: string,
  skillDir: string,
  description: string,
): Promise<BundledSkillFile[]> => {
  const files: BundledSkillFile[] = [];

  const skillMdFile = Bun.file(join(skillDir, "SKILL.md"));
  if (await skillMdFile.exists()) {
    files.push({
      skillName,
      skillFile: "SKILL.md",
      description,
      content: await skillMdFile.text(),
    });
  }

  const referencesDir = join(skillDir, REFERENCES_SUBDIR);
  const referencesInfo = await stat(referencesDir).catch(() => null);
  if (referencesInfo?.isDirectory()) {
    const referenceNames = await readdir(referencesDir);
    for (const name of referenceNames) {
      if (!name.endsWith(".md")) continue;
      const file = Bun.file(join(referencesDir, name));
      if (!(await file.exists())) continue;
      files.push({
        skillName,
        skillFile: `${REFERENCES_SUBDIR}/${name}`,
        description,
        content: await file.text(),
      });
    }
  }

  return files;
};

const collectBundledSkillFiles = async (): Promise<BundledSkillFile[]> => {
  let topLevel: string[];
  try {
    topLevel = await readdir(BUNDLED_SRC_DIR);
  } catch (err) {
    console.warn(
      `[skills-vectorize] bundled source directory missing at ${BUNDLED_SRC_DIR}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const all: BundledSkillFile[] = [];
  for (const child of topLevel) {
    if (child.startsWith(".")) continue;
    const skillDir = join(BUNDLED_SRC_DIR, child);
    const info = await stat(skillDir).catch(() => null);
    if (!info?.isDirectory()) continue;

    const skillMdPath = join(skillDir, "SKILL.md");
    const skillMdFile = Bun.file(skillMdPath);
    if (!(await skillMdFile.exists())) continue;

    const { description, name } = parseFrontmatter(await skillMdFile.text());
    if (!description) continue;

    const skillName = name ?? child;
    const files = await readSkillFiles(skillName, skillDir, description);
    all.push(...files);
  }

  return all;
};

/**
 * Boot-time RAG indexer for the bundled skills.
 *
 * Walks `bundled/<skill>/SKILL.md` + `bundled/<skill>/references/*.md`,
 * vectorises each file as a global row in `ai_vectors`
 * (`team_id IS NULL`, `organization_id IS NULL`, `user_id IS NULL`),
 * then bulk-deletes any (skill_name, skill_file) tuple that exists in
 * the DB but no longer in the bundled set — this single diff covers
 * BOTH "skill removed" and "file removed inside a skill".
 *
 * Idempotence: `vectorizeSkillFile` short-circuits via `content_hash`
 * so a steady-state reboot does zero embed work.
 *
 * Concurrency: per-file calls run **sequentially** to avoid spiking
 * the OpenRouter cheap-model semaphore at boot — this is a one-shot
 * pass, not a hot path. Total boot cost on first run ≈ 9 skills × ~5
 * chunks × ~1 enrich call each ≈ 45 sub-second roundtrips.
 *
 * Fire-and-forget: errors are logged but never thrown — the boot
 * sequence must not block on a transient OpenRouter / DB hiccup.
 * Anything left mis-indexed is corrected on the next boot.
 */
export const vectorizeAllBundledSkills = async (): Promise<void> => {
  const startedAt = Date.now();
  const bundled = await collectBundledSkillFiles();

  let indexed = 0;
  let skipped = 0;
  for (const file of bundled) {
    try {
      const result = await vectorizeSkillFile(file);
      if (result.skipped) skipped++;
      else indexed++;
    } catch (err) {
      console.error(
        `[skills-vectorize] failed to index ${file.skillName}/${file.skillFile}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Cleanup boot — bulk DELETE for tuples that exist in DB but no
  // longer in the bundled set. Covers both "skill folder removed" and
  // "file removed inside a skill" with a single diff.
  const present = new Set(bundled.map((b) => `${b.skillName}::${b.skillFile}`));
  let removed = 0;
  try {
    const inDb = await listIndexedSkillFiles();
    for (const row of inDb) {
      const key = `${row.skillName}::${row.skillFile}`;
      if (present.has(key)) continue;
      const deleted = await deleteSkillFileVectors(
        row.skillName,
        row.skillFile,
      );
      if (deleted > 0) removed++;
    }
  } catch (err) {
    console.error(
      "[skills-vectorize] cleanup pass failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const duration = Date.now() - startedAt;
  console.log(
    `[skills-vectorize] indexed=${indexed} skipped=${skipped} removed=${removed} duration=${duration}ms`,
  );
};
