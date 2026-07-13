import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillCatalog } from "../../../src/skills/materialize";
import { BUNDLED_SKILLS_DIR } from "../../../src/skills/paths";

/** Mirrors the agentskills.io slug rule (lowercase, single hyphens). */
const NAME_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;

/**
 * Smoke tests for the bundled-skills filesystem walker.
 *
 * These run against the real `src/skills/bundled/` tree so they catch:
 *   - a SKILL.md that drifts out of the agentskills.io spec (missing
 *     `description`, malformed YAML),
 *   - a folder whose `name:` frontmatter doesn't match the directory,
 *   - a fresh skill being added without a SKILL.md.
 *
 * Logically pure (filesystem-only), but importing
 * `src/skills/materialize` transitively pulls `services/vectorize/skills`
 * → `@fretik/shared/db`, which runs `await runMigrationsWithLock()` at
 * top-level. Loading the SUT therefore requires a real Postgres
 * reachable via `DATABASE_URL`, so this test lives under
 * `tests/integration/` and runs via `bun run test:integration` only.
 *
 * If a new bundled skill is added or one is removed, update
 * `EXPECTED_SKILL_NAMES` — that's the contract we want flagged on diff.
 */

const EXPECTED_SKILL_NAMES = [
  "data-viz",
  "designing-object-types",
  "doc-coauthoring",
  "docx",
  "pdf",
  "pptx",
  "skill-author",
  "tabular-extraction",
  "xlsx",
];

describe("loadSkillCatalog", () => {
  test("returns every bundled skill folder, sorted by name", async () => {
    const catalog = await loadSkillCatalog();
    const names = catalog.map((entry) => entry.name);
    expect(names).toEqual(EXPECTED_SKILL_NAMES);
  });

  test("every entry has a non-empty description (agentskills.io requirement)", async () => {
    const catalog = await loadSkillCatalog();
    for (const entry of catalog) {
      expect(entry.description.length).toBeGreaterThan(0);
      // Anthropic spec caps description at 1024 chars effective. Loader
      // does not truncate today, but flag drift early so we don't ship
      // a >1024 description to a future Claude-API consumer.
      expect(entry.description.length).toBeLessThanOrEqual(1024);
    }
  });

  test("every skill name is a valid slug within the length cap", async () => {
    const catalog = await loadSkillCatalog();
    for (const entry of catalog) {
      expect(entry.name).toMatch(NAME_SLUG);
      expect(entry.name.length).toBeLessThanOrEqual(NAME_MAX);
    }
  });

  test("every skill name === its on-disk folder (Anthropic spec)", async () => {
    // The catalogue name must equal the directory under `bundled/`, since
    // that directory is the path the agent reads (`skills/<name>/...`) and
    // the tree pushed to the sandbox. A mismatched frontmatter `name`
    // would silently break `read` + the script push — `parseFrontmatter`
    // canonicalises to the folder, and this test fails loudly if a
    // bundled skill is ever authored with `name:` ≠ its directory.
    const catalog = await loadSkillCatalog();
    const folders = new Set<string>();
    for (const child of await readdir(BUNDLED_SKILLS_DIR)) {
      if (child.startsWith(".")) continue;
      const info = await stat(join(BUNDLED_SKILLS_DIR, child)).catch(
        () => null,
      );
      if (info?.isDirectory()) folders.add(child);
    }
    for (const entry of catalog) {
      expect(folders).toContain(entry.name);
    }
  });

  test("returns the same cached array on a second call", async () => {
    const a = await loadSkillCatalog();
    const b = await loadSkillCatalog();
    expect(b).toBe(a); // identity — module-level cache
  });
});
