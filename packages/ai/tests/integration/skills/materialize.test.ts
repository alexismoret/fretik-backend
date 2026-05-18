import { describe, expect, test } from "bun:test";
import { loadSkillCatalog } from "../../../src/skills/materialize";

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
  "doc-coauthoring",
  "docx",
  "pdf",
  "pptx",
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

  test("frontmatter `name` matches folder name when explicit", async () => {
    const catalog = await loadSkillCatalog();
    // `loadSkillCatalog` falls back to the folder name when the
    // frontmatter `name` is invalid or missing. Our bundled skills
    // declare it explicitly — they MUST match the folder.
    for (const entry of catalog) {
      expect(EXPECTED_SKILL_NAMES).toContain(entry.name);
    }
  });

  test("returns the same cached array on a second call", async () => {
    const a = await loadSkillCatalog();
    const b = await loadSkillCatalog();
    expect(b).toBe(a); // identity — module-level cache
  });
});
