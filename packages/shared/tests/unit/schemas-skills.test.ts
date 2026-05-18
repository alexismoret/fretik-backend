import { describe, expect, test } from "bun:test";
import {
  skillNameParamSchema,
  skillSourceSchema,
  skillSummarySchema,
  skillsListResponseSchema,
  toggleSkillBodySchema,
} from "../../src/schemas/skills";

/**
 * Schema-level guarantees for `/team-skills/*`. The HTTP layer relies
 * on these schemas to reject malformed input before the service runs;
 * the frontend relies on them to narrow the response shape. If a
 * frontmatter slug rule, name length, or boolean payload shape changes
 * silently, these tests turn red.
 */

const VALID_SKILL_NAMES = [
  "docx",
  "data-viz",
  "tabular-extraction",
  "doc-coauthoring",
  "x", // single char allowed
  "a-b-c-d-e-f",
];

const INVALID_SKILL_NAMES = [
  "", // empty
  "Docx", // uppercase
  "docx_v2", // underscore
  "docx.v2", // dot
  "-leading", // leading hyphen
  "trailing-", // trailing hyphen
  "double--hyphen",
  "x".repeat(65), // 65 chars → over the 64-char agentskills.io cap
];

describe("skillNameParamSchema", () => {
  test.each(VALID_SKILL_NAMES)("accepts valid slug %s", (name) => {
    expect(skillNameParamSchema.safeParse({ name }).success).toBe(true);
  });

  test.each(INVALID_SKILL_NAMES)("rejects invalid slug %s", (name) => {
    expect(skillNameParamSchema.safeParse({ name }).success).toBe(false);
  });
});

describe("toggleSkillBodySchema", () => {
  test("accepts the canonical { enabled: boolean } shape", () => {
    expect(toggleSkillBodySchema.safeParse({ enabled: true }).success).toBe(
      true,
    );
    expect(toggleSkillBodySchema.safeParse({ enabled: false }).success).toBe(
      true,
    );
  });

  test("rejects anything that isn't a boolean", () => {
    expect(toggleSkillBodySchema.safeParse({}).success).toBe(false);
    expect(toggleSkillBodySchema.safeParse({ enabled: "true" }).success).toBe(
      false,
    );
    expect(toggleSkillBodySchema.safeParse({ enabled: 1 }).success).toBe(false);
    expect(toggleSkillBodySchema.safeParse({ enabled: null }).success).toBe(
      false,
    );
  });
});

describe("skillSourceSchema", () => {
  test("accepts the two known source kinds", () => {
    expect(skillSourceSchema.safeParse("bundled").success).toBe(true);
    expect(skillSourceSchema.safeParse("team_uploaded").success).toBe(true);
  });

  test("rejects unknown sources (drift guard for the DB enum)", () => {
    expect(skillSourceSchema.safeParse("legacy").success).toBe(false);
    expect(skillSourceSchema.safeParse("").success).toBe(false);
  });
});

describe("skillSummarySchema", () => {
  const validSummary = {
    id: "0193ad07-1100-7100-aaaa-bbbbccccdddd",
    name: "xlsx",
    description: "Spreadsheet generation skill.",
    isDefault: true,
    enabled: true,
    version: "1.0.0",
    source: "bundled" as const,
  };

  test("accepts a complete, valid summary", () => {
    expect(skillSummarySchema.safeParse(validSummary).success).toBe(true);
  });

  test("rejects descriptions over the 1024 char agentskills.io cap", () => {
    const oversized = { ...validSummary, description: "x".repeat(1025) };
    expect(skillSummarySchema.safeParse(oversized).success).toBe(false);
  });

  test("rejects an empty description", () => {
    const empty = { ...validSummary, description: "" };
    expect(skillSummarySchema.safeParse(empty).success).toBe(false);
  });

  test("rejects versions exceeding the 20 char DB column", () => {
    const longVersion = { ...validSummary, version: "1.0.0-".padEnd(21, "x") };
    expect(skillSummarySchema.safeParse(longVersion).success).toBe(false);
  });

  test("rejects an invalid UUID id", () => {
    const badId = { ...validSummary, id: "not-a-uuid" };
    expect(skillSummarySchema.safeParse(badId).success).toBe(false);
  });
});

describe("skillsListResponseSchema", () => {
  test("accepts an empty list (new team, no overrides, deleted catalogue)", () => {
    expect(skillsListResponseSchema.safeParse({ skills: [] }).success).toBe(
      true,
    );
  });

  test("rejects a payload missing the top-level `skills` key", () => {
    expect(skillsListResponseSchema.safeParse({}).success).toBe(false);
  });
});
