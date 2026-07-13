import { describe, expect, test } from "bun:test";
import {
  companionFilesCount,
  detectLicense,
  extractDescription,
  findSkillMd,
  isRestrictedLicense,
  parseFrontmatter,
  splitSkillId,
} from "../../src/lib/skills-registry/normalize";
import type { SkillFile } from "../../src/lib/skills-registry/types";

/**
 * Skill-bundle parsing: recover the real SKILL.md body (not the one-line
 * summary the old catalog stored) and gate proprietary licenses out of install.
 */

describe("splitSkillId", () => {
  test("splits owner/repo/slug using the source", () => {
    expect(splitSkillId("anthropics/skills/pdf", "anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      slug: "pdf",
    });
  });
});

describe("parseFrontmatter", () => {
  test("strips YAML frontmatter and returns the body", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: pdf\ndescription: Manipulate PDFs\n---\n# PDF\n\nDo things.",
    );
    expect(frontmatter.name).toBe("pdf");
    expect(frontmatter.description).toBe("Manipulate PDFs");
    expect(body).toBe("# PDF\n\nDo things.");
  });

  test("no frontmatter leaves content intact", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a body");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# Just a body");
  });
});

describe("extractDescription", () => {
  test("prefers frontmatter description", () => {
    expect(extractDescription({ description: "From FM" }, "# H\nbody")).toBe(
      "From FM",
    );
  });

  test("falls back to first non-heading body line", () => {
    expect(extractDescription({}, "# Heading\n\nReal first line.")).toBe(
      "Real first line.",
    );
  });
});

describe("isRestrictedLicense", () => {
  test("flags Anthropic's proprietary doc-skill license", () => {
    const license =
      "© 2025 Anthropic, PBC. All rights reserved. LICENSE: Use of these materials... users may not extract these materials from the Services.";
    expect(isRestrictedLicense(license)).toBe(true);
  });

  test("permits MIT / Apache", () => {
    expect(isRestrictedLicense("MIT")).toBe(false);
    expect(isRestrictedLicense("Apache-2.0")).toBe(false);
  });

  test("null license is not restricted", () => {
    expect(isRestrictedLicense(null)).toBe(false);
  });
});

describe("detectLicense", () => {
  test("reads frontmatter license first", () => {
    expect(detectLicense({ license: "MIT" }, [])).toBe("MIT");
  });

  test("falls back to a LICENSE file's contents", () => {
    const files: SkillFile[] = [
      { path: "SKILL.md", contents: "body" },
      { path: "LICENSE.txt", contents: "All rights reserved." },
    ];
    expect(detectLicense({}, files)).toContain("All rights reserved");
  });
});

describe("findSkillMd + companionFilesCount", () => {
  const files: SkillFile[] = [
    { path: "SKILL.md", contents: "---\nname: x\n---\nbody" },
    { path: "scripts/run.py", contents: "print(1)" },
    { path: "reference.md", contents: "ref" },
  ];

  test("finds the shallowest SKILL.md", () => {
    expect(findSkillMd(files)?.path).toBe("SKILL.md");
  });

  test("counts companion files", () => {
    expect(companionFilesCount(files)).toBe(2);
  });
});
