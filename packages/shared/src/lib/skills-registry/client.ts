/**
 * skills.sh registry client — DISCOVERY + CONTENT, no API key. Bare `fetch`
 * against the unauthenticated endpoints the `npx skills` CLI itself uses.
 * Feeds the skills hub + install flow. Search + parsed metadata are
 * Redis-cached; raw downloads are not (large, and only fetched at install time).
 */

import {
  arr,
  asString,
  isRecord,
  num,
  prop,
  str,
} from "../../external-apps/json-access";
import { selectOrCache } from "../redis";
import {
  detectLicense,
  extractDescription,
  findSkillMd,
  isRestrictedLicense,
  parseFrontmatter,
  splitSkillId,
} from "./normalize";
import type {
  SkillAudit,
  SkillFile,
  SkillsRegistryDownload,
  SkillsRegistryEntry,
  SkillsRegistryMeta,
} from "./types";

const SEARCH_BASE = Bun.env.SKILLS_REGISTRY_BASE_URL ?? "https://skills.sh";
const AUDIT_BASE =
  Bun.env.SKILLS_AUDIT_BASE_URL ?? "https://add-skill.vercel.sh";
const SEARCH_CACHE_TTL_SECONDS = 10 * 60;
const META_CACHE_TTL_SECONDS = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_LIMIT = 100;

/** The official publisher shelves, shown as the default (no-query) view. */
export const OFFICIAL_SKILL_SOURCES = ["anthropics/skills", "openai/skills"];

const skillsGet = async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`skills.sh GET ${url} failed: ${res.status}`);
  return res.json();
};

const parseSearchEntry = (raw: unknown): SkillsRegistryEntry | undefined => {
  const id = asString(prop(raw, "id"));
  const source = asString(prop(raw, "source"));
  if (id === undefined || id === "" || source === undefined || source === "") {
    return undefined;
  }
  const { owner, repo, slug } = splitSkillId(id, source);
  if (owner === "" || repo === "" || slug === "") return undefined;
  const name = asString(prop(raw, "name")) ?? asString(prop(raw, "skillId"));
  return {
    id,
    owner,
    repo,
    slug,
    displayName: name ?? slug,
    installs: num(prop(raw, "installs")),
    source,
  };
};

/** Search skills by term (fuzzy + semantic, name/description matched by skills.sh). */
export const searchSkills = async (input: {
  q: string;
  limit?: number;
}): Promise<SkillsRegistryEntry[]> =>
  selectOrCache(
    async () => {
      const params = new URLSearchParams({
        q: input.q,
        limit: String(input.limit ?? SEARCH_LIMIT),
      });
      const body = await skillsGet(
        `${SEARCH_BASE}/api/search?${params.toString()}`,
      );
      return arr(prop(body, "skills"))
        .map(parseSearchEntry)
        .filter((e): e is SkillsRegistryEntry => e !== undefined);
    },
    `skills-registry:search:${input.q}:${input.limit ?? SEARCH_LIMIT}`,
    SEARCH_CACHE_TTL_SECONDS,
  );

/**
 * The official shelf: skills.sh rejects an empty query, so the no-query view is
 * built by searching each official publisher and keeping only its own skills.
 */
export const listOfficialShelf = async (): Promise<SkillsRegistryEntry[]> =>
  selectOrCache(
    async () => {
      const perSource = await Promise.all(
        OFFICIAL_SKILL_SOURCES.map(async (source) => {
          const term = source.split("/")[0] ?? source;
          const results = await searchSkills({ q: term, limit: SEARCH_LIMIT });
          return results.filter((e) => e.source === source);
        }),
      );
      return perSource.flat().sort((a, b) => b.installs - a.installs);
    },
    `skills-registry:shelf`,
    SEARCH_CACHE_TTL_SECONDS,
  );

const parseDownload = (raw: unknown): SkillsRegistryDownload => {
  const files: SkillFile[] = arr(prop(raw, "files"))
    .map((f): SkillFile | undefined => {
      const path = asString(prop(f, "path"));
      if (path === undefined || path === "") return undefined;
      return { path, contents: str(prop(f, "contents")) };
    })
    .filter((f): f is SkillFile => f !== undefined);
  return { files, hash: str(prop(raw, "hash")) };
};

/** Download a skill's full file bundle (uncached — install-time only). */
export const downloadSkill = async (
  owner: string,
  repo: string,
  slug: string,
): Promise<SkillsRegistryDownload> => {
  const body = await skillsGet(
    `${SEARCH_BASE}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`,
  );
  return parseDownload(body);
};

/** Hydrated, cacheable metadata for a skill (description/license/filesCount). */
export const getSkillMeta = async (
  owner: string,
  repo: string,
  slug: string,
): Promise<SkillsRegistryMeta | null> =>
  selectOrCache(
    async () => {
      const download = await downloadSkill(owner, repo, slug);
      const skillMd = findSkillMd(download.files);
      if (skillMd === undefined) return null;
      const { frontmatter, body } = parseFrontmatter(skillMd.contents);
      const license = detectLicense(frontmatter, download.files);
      return {
        displayName: frontmatter.name ?? slug,
        description: extractDescription(frontmatter, body),
        license,
        restrictedLicense: isRestrictedLicense(license),
        filesCount: download.files.length,
        hash: download.hash,
      };
    },
    `skills-registry:meta:${owner}/${repo}/${slug}`,
    META_CACHE_TTL_SECONDS,
  );

/** Advisory security audits (never blocking, never throws). */
export const fetchSkillAudit = async (
  source: string,
  slug: string,
): Promise<Record<string, SkillAudit> | null> =>
  selectOrCache(
    async () => {
      try {
        const params = new URLSearchParams({ source, skills: slug });
        const body = await skillsGet(
          `${AUDIT_BASE}/audit?${params.toString()}`,
        );
        const bySlug = prop(body, slug);
        if (!isRecord(bySlug)) return {};
        const audits: Record<string, SkillAudit> = {};
        for (const [auditor, verdict] of Object.entries(bySlug)) {
          const audit: SkillAudit = {};
          const risk = asString(prop(verdict, "risk"));
          if (risk !== undefined) audit.risk = risk;
          const score = prop(verdict, "score");
          if (typeof score === "number") audit.score = score;
          const alerts = prop(verdict, "alerts");
          if (typeof alerts === "number") audit.alerts = alerts;
          const analyzedAt = asString(prop(verdict, "analyzedAt"));
          if (analyzedAt !== undefined) audit.analyzedAt = analyzedAt;
          audits[auditor] = audit;
        }
        return audits;
      } catch {
        return null;
      }
    },
    `skills-registry:audit:${source}:${slug}`,
    META_CACHE_TTL_SECONDS,
  );

/** Map with bounded concurrency (for hydrating a page of search results). */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- draining a shared cursor is intentionally sequential per worker
      results[index] = await fn(item, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
};
