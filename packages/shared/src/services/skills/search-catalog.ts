import {
  getSkillMeta,
  listOfficialShelf,
  mapWithConcurrency,
  OFFICIAL_SKILL_SOURCES,
  searchSkills,
} from "../../lib/skills-registry/client";
import type { SkillsRegistryEntry } from "../../lib/skills-registry/types";
import type {
  SkillCatalogEntry,
  SkillCatalogResponse,
} from "../../schemas/skills";

/**
 * Search the skills.sh catalog with local page-based pagination. No query ⇒ the
 * official shelf (Anthropic + OpenAI). skills.sh returns no description in
 * search results, so ONLY the returned page is hydrated (one download each,
 * bounded concurrency, Redis-cached) to fill `description` + `filesCount`.
 */

const HYDRATION_CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 12;

const isOfficial = (source: string): boolean =>
  OFFICIAL_SKILL_SOURCES.includes(source);

const hydrate = async (
  entry: SkillsRegistryEntry,
): Promise<SkillCatalogEntry> => {
  const meta = await getSkillMeta(entry.owner, entry.repo, entry.slug).catch(
    () => null,
  );
  return {
    id: entry.id,
    owner: entry.owner,
    repo: entry.repo,
    slug: entry.slug,
    displayName: entry.displayName,
    description: meta?.description ?? "",
    installs: entry.installs,
    official: isOfficial(entry.source),
    filesCount: meta?.filesCount ?? 1,
  };
};

export const searchSkillCatalog = async (input: {
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<SkillCatalogResponse> => {
  const all =
    input.q !== undefined && input.q !== ""
      ? await searchSkills({ q: input.q, limit: 100 })
      : await listOfficialShelf();

  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = input.page ?? 1;
  const start = (page - 1) * pageSize;
  const pageEntries = all.slice(start, start + pageSize);

  const entries = await mapWithConcurrency(
    pageEntries,
    HYDRATION_CONCURRENCY,
    hydrate,
  );

  return {
    entries,
    pagination: {
      currentPage: page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
      totalCount: all.length,
    },
  };
};
