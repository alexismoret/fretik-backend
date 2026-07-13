import { describe, expect, test } from "bun:test";
import {
  skillSourceSchema,
  skillSummarySchema,
  skillsListResponseSchema,
  updateSkillRequestSchema,
} from "../../src/schemas/skills";

/**
 * Schema-level guarantees for `/skills/*`. The HTTP layer relies
 * on these schemas to reject malformed input before the service runs;
 * the frontend relies on them to narrow the response shape. If a
 * frontmatter slug rule, name length, or update payload shape changes
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

describe("skillSummarySchema name regex", () => {
  const validSummary = (name: string) => ({
    id: "0193ad07-1100-7100-aaaa-bbbbccccdddd",
    name,
    description: "x",
    isDefault: false,
    enabled: true,
    version: "1.0.0",
    source: "bundled" as const,
    sourceUrl: null,
  });

  test.each(VALID_SKILL_NAMES)("accepts valid slug %s", (name) => {
    expect(skillSummarySchema.safeParse(validSummary(name)).success).toBe(true);
  });

  test.each(INVALID_SKILL_NAMES)("rejects invalid slug %s", (name) => {
    expect(skillSummarySchema.safeParse(validSummary(name)).success).toBe(
      false,
    );
  });
});

describe("updateSkillRequestSchema", () => {
  test("accepts a single-field patch", () => {
    expect(updateSkillRequestSchema.safeParse({ enabled: true }).success).toBe(
      true,
    );
    expect(
      updateSkillRequestSchema.safeParse({ description: "x" }).success,
    ).toBe(true);
    expect(updateSkillRequestSchema.safeParse({ body: "x" }).success).toBe(
      true,
    );
  });

  test("accepts a combined patch", () => {
    expect(
      updateSkillRequestSchema.safeParse({
        description: "x",
        body: "y",
        enabled: false,
      }).success,
    ).toBe(true);
  });

  test("rejects an empty patch (would be a silent no-op)", () => {
    expect(updateSkillRequestSchema.safeParse({}).success).toBe(false);
  });

  test("rejects an empty string description (zod min(1))", () => {
    expect(
      updateSkillRequestSchema.safeParse({ description: "" }).success,
    ).toBe(false);
  });

  test("rejects body over the 102 400 byte cap", () => {
    expect(
      updateSkillRequestSchema.safeParse({ body: "x".repeat(102_401) }).success,
    ).toBe(false);
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
    sourceUrl: null,
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
