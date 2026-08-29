/**
 * One name per upstream company, across sources that disagree about spelling.
 *
 * The two catalogue APIs describe the same hosts differently — the Gateway
 * reports machine slugs (`togetherai`, `bedrock`, `vertexAnthropic`), OpenRouter
 * reports display names (`Together`, `Amazon Bedrock`, `Google`, `Mancer 2`) —
 * and a pool, a quarantine and an enrichment join all have to mean the same
 * thing on both. Measured 2026-08-29 against both live endpoint APIs for
 * `deepseek-v4-flash-0731`, `minimax-m3`, `gpt-oss-120b` and `glm-5.2`.
 *
 * Matching is deliberately CONSERVATIVE. Case and punctuation are folded, then
 * an explicit alias table maps the remaining disagreements. Anything that does
 * not match stays unmatched and is reported: a fuzzy match here would silently
 * apply one host's quarantine to a different company.
 */

import type { EndpointStat, TransportId } from "./types";

/** Fold case, spaces and punctuation. `Amazon Bedrock` → `amazonbedrock`. */
const fold = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Folded spelling → canonical name. Only pairs verified against both APIs are
 * listed; an unlisted host keeps its folded spelling, which is already
 * identical across sources for the large majority (`deepinfra`, `gmicloud`,
 * `baseten`, `novita`, `parasail`, `cerebras`, `groq`, `nebius`, `fireworks`).
 */
const ALIASES: Readonly<Record<string, string>> = {
  // Gateway `togetherai` vs OpenRouter `Together`.
  togetherai: "together",
  // Gateway `bedrock` vs OpenRouter `Amazon Bedrock`.
  amazonbedrock: "bedrock",
  // OpenRouter splits Google's first-party surface into `Google AI Studio` and
  // `Google`; the Gateway calls them `google` and `vertex`. AI Studio is the
  // one that maps to plain `google`.
  googleaistudio: "google",
  // Anthropic through Vertex: `vertexAnthropic` on the Gateway. Kept distinct
  // from `vertex` (Gemini's route) on purpose.
  vertexanthropic: "vertexanthropic",
  // Gemini through Vertex: `vertex` on the Gateway, slug `google-vertex` on
  // OpenRouter. This pair is why identities are derived from OpenRouter's slug
  // and not its display name — the display name is the bare word `Google`,
  // which would fold onto AI Studio and merge two routes that differ in price,
  // retention and region.
  googlevertex: "vertex",
  // Anthropic's AWS surface: `claudeaws` on the Gateway, and OpenRouter spells
  // it `Claude Platform on AWS` with slug `claude-on-aws`. Both spellings are
  // listed because rows captured before the switch to slugs carry the first.
  claudeplatformonaws: "claudeaws",
  claudeonaws: "claudeaws",
  // Z.AI publishes with a dot.
  zai: "zai",
  // Alibaba's own spelling varies by surface.
  alibabacloud: "alibaba",
  qwen: "alibaba",
};

/**
 * Canonical, comparable name for an upstream. Use it everywhere a provider is
 * stored, compared or quarantined; keep the source spelling only for display.
 */
export const normalizeProviderName = (name: string): string => {
  const folded = fold(name);
  return ALIASES[folded] ?? folded;
};

/** Whether two source spellings denote the same upstream. */
export const sameProvider = (a: string, b: string): boolean =>
  normalizeProviderName(a) === normalizeProviderName(b);

/** Normalize a list, dropping empties and duplicates but keeping order. */
export const normalizeProviderList = (names: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeProviderName(raw);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

/**
 * Translate canonical identities into the spellings ONE transport's provider
 * filter accepts, using that transport's own endpoint data as the dictionary.
 *
 * The identity is what we store, compare and quarantine; it is not what either
 * API accepts. `bedrock` is `amazon-bedrock` to OpenRouter and `bedrock` to the
 * gateway; `together` is `together` and `togetherai`. Nothing derives one from
 * the other, so the endpoints — which carry both — are the only honest source.
 *
 * `onUnresolved` exists because the safe direction is OPPOSITE for the two
 * kinds of list, and picking one default would be wrong half the time:
 *
 * - `"drop"` for an ALLOW-list. An unknown name in the gateway's `only` fails
 *   the whole request ("No available providers match the 'only' filter"),
 *   so a name we cannot spell must not be sent. Dropping narrows the list,
 *   which is the harmless direction.
 * - `"keep"` for an EXCLUSION list. An unknown name in OpenRouter's `ignore`
 *   is silently discarded, so passing the identity through costs nothing and
 *   may still match — whereas dropping it would silently lift a quarantine.
 *
 * Either way the identities that could not be translated come back in
 * `unresolved`, so the caller can say so instead of quietly proceeding.
 */
export const wireNameIndex = (
  endpoints: readonly EndpointStat[],
  transport: TransportId,
): Map<string, string> => {
  const index = new Map<string, string>();
  for (const endpoint of endpoints) {
    const wire = endpoint.wireNames[transport];
    // One host commonly serves several routes (`fireworks`, `fireworks/fast`,
    // `fireworks/fast-us`). They share a filter token, so first-wins is not a
    // choice between candidates — it is the same answer each time.
    if (wire !== undefined && !index.has(endpoint.provider))
      index.set(endpoint.provider, wire);
  }
  return index;
};

export const toWireNames = (
  identities: readonly string[],
  wireNameByIdentity: ReadonlyMap<string, string>,
  onUnresolved: "drop" | "keep",
): { names: string[]; unresolved: string[] } => {
  const names: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const identity of identities) {
    const wire = wireNameByIdentity.get(identity);
    if (wire === undefined) {
      unresolved.push(identity);
      if (onUnresolved === "drop") continue;
    }
    const name = wire ?? identity;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return { names, unresolved };
};
