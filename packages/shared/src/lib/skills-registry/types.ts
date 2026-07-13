/**
 * Fretik-facing shapes for the skills.sh registry (Vercel's open agent-skills
 * index). DISCOVERY + CONTENT: search returns lightweight entries; the download
 * endpoint returns a skill's full file set (the real SKILL.md body + any
 * companion files) in one call. No user data transits skills.sh — we only send
 * search terms and fetch public skill content.
 */

/** One skill as returned by `GET /api/search`. */
export interface SkillsRegistryEntry {
  /** `owner/repo/slug` — the install handle. */
  id: string;
  owner: string;
  repo: string;
  slug: string;
  displayName: string;
  installs: number;
  /** `owner/repo` — the source repository. */
  source: string;
}

/** A file inside a downloaded skill bundle. */
export interface SkillFile {
  path: string;
  contents: string;
}

/** `GET /api/download/{owner}/{repo}/{slug}` — the full skill bundle. */
export interface SkillsRegistryDownload {
  files: SkillFile[];
  /** Content hash — persisted for provenance + change detection. */
  hash: string;
}

/** Lightweight, hydratable metadata parsed from a skill's SKILL.md + license. */
export interface SkillsRegistryMeta {
  displayName: string;
  description: string;
  /** Declared license text/id, or null when none is stated. */
  license: string | null;
  /** True when the license forbids extracting/redistributing the content. */
  restrictedLicense: boolean;
  /** Number of files in the bundle (>1 ⇒ companion files beyond SKILL.md). */
  filesCount: number;
  hash: string;
}

/** One auditor's verdict from the advisory audit endpoint. */
export interface SkillAudit {
  risk?: string;
  score?: number;
  alerts?: number;
  analyzedAt?: string;
}
