/**
 * Pure parsers for skill bundles: locate the SKILL.md, strip its YAML
 * frontmatter to recover the real body, and read the license so proprietary
 * skills can be refused at install. No network here — operates on a downloaded
 * `SkillFile[]`.
 */

import type { SkillFile } from "./types";

/** Split a `owner/repo/slug` id given its `owner/repo` source. */
export const splitSkillId = (
  id: string,
  source: string,
): { owner: string; repo: string; slug: string } => {
  const [owner = "", repo = ""] = source.split("/");
  const slug = id.startsWith(`${source}/`) ? id.slice(source.length + 1) : id;
  return { owner, repo, slug };
};

/** Depth of a file path (`a/b/SKILL.md` -> 2), for picking the shallowest. */
const depthOf = (path: string): number => path.split("/").length;

/** The bundle's SKILL.md (shallowest, case-insensitive), or undefined. */
export const findSkillMd = (files: SkillFile[]): SkillFile | undefined =>
  files
    .filter((f) => {
      const base = f.path.split("/").pop() ?? f.path;
      return base.toLowerCase() === "skill.md";
    })
    .sort((a, b) => depthOf(a.path) - depthOf(b.path))[0];

/** Parse leading YAML frontmatter; returns the flat string map + the body. */
export const parseFrontmatter = (
  content: string,
): { frontmatter: Record<string, string>; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (match === null || match[1] === undefined) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv === null || kv[1] === undefined || kv[2] === undefined) continue;
    frontmatter[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: content.slice(match[0].length) };
};

/** Description from frontmatter, else the first non-empty body line (capped). */
export const extractDescription = (
  frontmatter: Record<string, string>,
  body: string,
): string => {
  if (frontmatter.description !== undefined && frontmatter.description !== "") {
    return frontmatter.description;
  }
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return (firstLine ?? "").slice(0, 300);
};

/** Declared license: frontmatter `license`, else any LICENSE* file text. */
export const detectLicense = (
  frontmatter: Record<string, string>,
  files: SkillFile[],
): string | null => {
  if (frontmatter.license !== undefined && frontmatter.license !== "") {
    return frontmatter.license;
  }
  const licenseFile = files.find((f) => {
    const base = (f.path.split("/").pop() ?? f.path).toLowerCase();
    return base.startsWith("license");
  });
  return licenseFile !== undefined ? licenseFile.contents.slice(0, 500) : null;
};

/**
 * True when a license forbids extracting/copying/redistributing the content —
 * storing such a skill's body in our DB and serving it to customers would
 * violate it (e.g. Anthropic's proprietary doc skills). Conservative: only
 * flags explicit no-redistribution language.
 */
export const isRestrictedLicense = (license: string | null): boolean => {
  if (license === null) return false;
  return /all rights reserved|proprietary|may not (?:be )?(?:extract|copie|copy|reproduc|redistribut|distribut|sublicens|transfer)/i.test(
    license,
  );
};

/** Companion files beyond the SKILL.md (>0 ⇒ a body-only install is partial). */
export const companionFilesCount = (files: SkillFile[]): number => {
  const skillMd = findSkillMd(files);
  return files.filter((f) => f !== skillMd).length;
};
