import { type IconEntry, ICON_CATALOG } from "./catalog";

/**
 * Keyword search over the curated Lucide catalog — the backend for the chatbot
 * `searchIcons` tool and the frontend icon picker's filter box. Ranks on the
 * icon name + Lucide's own `tags` (its synonyms) + categories, so a query like
 * "delivery" finds `truck` (tag) and "company" finds `building-2` (tag). Pure +
 * in-memory: 480 entries, no DB, one source of truth for both surfaces.
 */

export type { IconEntry };

const ICON_NAMES: ReadonlySet<string> = new Set(
  ICON_CATALOG.map((i) => i.name),
);

/** True if `name` is a bare Lucide name in the curated catalog. */
export const isValidIcon = (name: string): boolean => ICON_NAMES.has(name);

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

/** Score one icon against one query token. Higher = better match. */
const scoreToken = (icon: IconEntry, token: string): number => {
  if (icon.name === token) return 100;
  const nameParts = icon.name.split("-");
  if (nameParts.includes(token)) return 40;
  if (icon.name.includes(token)) return 18;
  if (icon.tags.includes(token)) return 30;
  if (icon.tags.some((t) => t.includes(token))) return 10;
  if (icon.categories.includes(token)) return 6;
  return 0;
};

export interface IconSearchResult {
  name: string;
  tags: string[];
}

/**
 * Rank the catalog against a free-text query. Every query token must contribute
 * (AND semantics) so "red truck" doesn't match everything red; an empty/short
 * query returns a stable default slice. Returns up to `limit` results.
 */
export const searchIcons = (query: string, limit = 12): IconSearchResult[] => {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return ICON_CATALOG.slice(0, limit).map((i) => ({
      name: i.name,
      tags: i.tags,
    }));
  }
  const scored: { icon: IconEntry; score: number }[] = [];
  for (const icon of ICON_CATALOG) {
    let total = 0;
    let matchedEveryToken = true;
    for (const token of tokens) {
      const s = scoreToken(icon, token);
      if (s === 0) matchedEveryToken = false;
      total += s;
    }
    if (matchedEveryToken && total > 0) scored.push({ icon, score: total });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.icon.name.localeCompare(b.icon.name),
  );
  return scored
    .slice(0, limit)
    .map(({ icon }) => ({ name: icon.name, tags: icon.tags }));
};
