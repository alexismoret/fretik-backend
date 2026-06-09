import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteSkillFileVectors,
  listIndexedSkillFiles,
  vectorizeSkillFile,
} from "../services/vectorize/skills";
import { BUNDLED_SKILLS_DIR } from "./paths";

/**
 * Bundled-skills materialiser.
 *
 * Two responsibilities:
 *
 *  1. **Filesystem catalogue cache** (`loadSkillCatalog` /
 *     `getSkillCatalog`). Walks `bundled/<name>/SKILL.md`, parses the
 *     spec-compliant frontmatter (`name` + `description`), and caches
 *     the result at module level. Used today only by the vectoriser.
 *     The agent system prompt no longer reads from this cache — it
 *     queries the `skills` DB table (which is seeded via migration
 *     and is the canonical source for the public catalogue + per-team
 *     toggle state).
 *
 *  2. **Boot-time RAG indexer** (`vectorizeAllBundledSkills`). Embeds
 *     SKILL.md + references/*.md into `ai_vectors` so the chatbot's
 *     `searchKnowledge` tool can route skill-shaped questions to the
 *     right playbook on its own. Idempotent + fire-and-forget.
 *
 * Frontmatter shape conforms to the agentskills.io spec — only `name`
 * and `description` are read here. Fretik-specific metadata
 * (`is_default`, `version`) lives in the `skills` DB row, not in the
 * markdown frontmatter, so the SKILL.md files stay portable to any
 * Anthropic-native Skills consumer.
 */

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /**
   * Fretik-specific defaults applied at first INSERT by the bundled
   * catalogue sync. Optional and only honoured when the skill is
   * NEW — existing DB rows are never overwritten so manual flips
   * persist.
   *
   * Lifted from `metadata.fretik_is_default` / `metadata.fretik_is_meta`
   * in the SKILL.md frontmatter (Anthropic-spec-compatible — these
   * keys live under the open-ended `metadata` namespace).
   */
  isDefault?: boolean;
  isMeta?: boolean;
}

const BUNDLED_SRC_DIR = BUNDLED_SKILLS_DIR;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let cachedCatalog: SkillCatalogEntry[] | null = null;

interface ParsedFrontmatter {
  name?: string;
  description: string;
  isDefault?: boolean;
  isMeta?: boolean;
}

const readBoolFromMetadata = (
  metadata: unknown,
  key: string,
): boolean | undefined => {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
};

/**
 * Read the YAML frontmatter of a SKILL.md and lift `name` +
 * `description`. Uses `Bun.YAML.parse` (native, no extra dep) so
 * multi-line descriptions and YAML block scalars work out of the box.
 *
 * Returns `null` when the file has no frontmatter, the YAML fails to
 * parse, or no usable description is present. Callers treat that as
 * "skip this skill, log a warning" rather than crashing the boot.
 */
const parseFrontmatter = (
  body: string,
  skillFolder: string,
): ParsedFrontmatter | null => {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    console.warn(`[skills] ${skillFolder}: SKILL.md has no front-matter`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1] ?? "");
  } catch (err) {
    console.warn(
      `[skills] ${skillFolder}: front-matter YAML parse failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    console.warn(`[skills] ${skillFolder}: front-matter is not an object`);
    return null;
  }

  const fm = parsed as Record<string, unknown>;
  const rawName = fm.name;
  const rawDescription = fm.description;

  if (
    typeof rawDescription !== "string" ||
    rawDescription.trim().length === 0
  ) {
    console.warn(
      `[skills] ${skillFolder}: SKILL.md missing description in front-matter`,
    );
    return null;
  }

  const name = typeof rawName === "string" ? rawName.trim() : undefined;
  if (name !== undefined && !NAME_PATTERN.test(name)) {
    console.warn(
      `[skills] ${skillFolder}: front-matter name "${name}" violates [a-z0-9-] slug rule, falling back to folder name`,
    );
  } else if (name !== undefined && name !== skillFolder) {
    // Anthropic spec requires `name` === directory. A valid-but-mismatched
    // name would register the skill under one identity while its files
    // (SKILL.md, references/, scripts/) live under the folder — breaking
    // every `read("skills/<name>/...")` and the sandbox script push.
    // Canonicalise to the folder so the catalogue name always equals the
    // readable path; the CI test (materialize.test.ts) flags the mismatch.
    console.warn(
      `[skills] ${skillFolder}: front-matter name "${name}" does not match its folder; using folder name (Anthropic spec requires name === directory)`,
    );
  }

  // Only honour the front-matter name when it is a valid slug AND matches
  // the folder; otherwise the caller falls back to the folder name.
  const usableName =
    name !== undefined && NAME_PATTERN.test(name) && name === skillFolder
      ? name
      : undefined;

  return {
    name: usableName,
    description: rawDescription.trim(),
    isDefault: readBoolFromMetadata(fm.metadata, "fretik_is_default"),
    isMeta: readBoolFromMetadata(fm.metadata, "fretik_is_meta"),
  };
};

/**
 * Walk the bundled source tree once and produce the in-memory
 * catalogue (skill name + description). Idempotent + cached at
 * module level — bundled skills don't change at runtime.
 *
 * Today this cache is consumed by the vectoriser only. The agent
 * system prompt reads from the `skills` DB table instead so it can
 * apply per-team enable/disable overrides without rebooting the
 * service.
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
      const parsed = parseFrontmatter(body, child);
      if (!parsed) return;

      entries.push({
        name: parsed.name ?? child,
        description: parsed.description,
        isDefault: parsed.isDefault,
        isMeta: parsed.isMeta,
      });
    }),
  );

  entries.sort((a, b) => a.name.localeCompare(b.name));
  cachedCatalog = entries;
  return entries;
};

/**
 * Synchronous read-only accessor for the in-memory catalogue. Returns
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

    const parsed = parseFrontmatter(await skillMdFile.text(), child);
    if (!parsed) continue;

    const skillName = parsed.name ?? child;
    const files = await readSkillFiles(skillName, skillDir, parsed.description);
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
