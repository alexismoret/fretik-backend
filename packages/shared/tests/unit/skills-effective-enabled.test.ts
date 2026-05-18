import { describe, expect, test } from "bun:test";
import { computeEffectiveEnabled } from "../../src/services/skills/compute-effective-enabled";

/**
 * Pure-logic contract for the effective `enabled` state of a skill
 * for a given team. The full `listSkillsForTeam` integration test
 * lives elsewhere (would need Postgres) — this locks the rule itself
 * so any silent flip (e.g. "default off for configurable") is caught
 * before it ships.
 */

describe("computeEffectiveEnabled", () => {
  test("always-on skill is enabled regardless of any override", () => {
    expect(computeEffectiveEnabled(true, null)).toBe(true);
    expect(computeEffectiveEnabled(true, true)).toBe(true);
    // Defence in depth: even a stale `team_skills` row marked false
    // for an always-on skill must NOT disable it. The upsert service
    // refuses to create such a row but the rule wins anyway.
    expect(computeEffectiveEnabled(true, false)).toBe(true);
  });

  test("configurable skill follows the team override when set", () => {
    expect(computeEffectiveEnabled(false, true)).toBe(true);
    expect(computeEffectiveEnabled(false, false)).toBe(false);
  });

  test("configurable skill with no override defaults to enabled", () => {
    // Current product decision: configurable skills are ON by default
    // for new teams. If this rule ever flips to off-by-default, this
    // line is the single source of truth that needs updating.
    expect(computeEffectiveEnabled(false, null)).toBe(true);
  });
});
