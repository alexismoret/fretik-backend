/**
 * How a model PRESENTS: its name, its maker's mark, its colour.
 *
 * Kept out of the profile registry on purpose — that one holds engineering
 * decisions, this one holds nothing a request depends on. What is hand-written
 * here is exactly what no API publishes:
 *
 * - `FAMILY_BRANDING` — per family: the vendor's mark and brand colour (the
 *   marks are monochrome, so the colour has to live beside them), plus an
 *   optional logo-faithful gradient. Per family, never per model.
 * - `FAMILY_BY_CATALOGUE_OWNER` — the handful of places where the catalogue
 *   names the company and we brand the model line.
 *
 * Everything else is READ rather than declared. A model's name comes from the
 * catalogue serving it (`getModelDisplayName`), and its quantitative metrics
 * from `services/model-metrics`. That is what lets a model discovered at three
 * in the morning render like any other.
 */

import { getLiveStateSync } from "@fretik/shared/services/model-registry/live";
import type { KnownModelFamily, ModelFamily } from "./types";

export interface FamilyBranding {
  /** Iconify name — simple-icons brand mark (verified) or a lucide fallback. */
  icon: string;
  /** Brand colour hex — applied to the (monochrome) icon + card accents. */
  brandColor: string;
  /** Optional logo-faithful gradient for the card accent. */
  brandGradient?: { from: string; to: string };
}

/**
 * Strip the maker's name where a catalogue prefixed it: `"OpenAI: GPT-5.6 Luna
 * Pro"` → `"GPT-5.6 Luna Pro"`.
 *
 * Worth doing for two reasons: the card already carries the vendor's own mark
 * and colour, so the prefix says the same thing twice; and the catalogues
 * disagree on whether to add one at all — `"Claude Sonnet 4.5"` bare beside
 * `"OpenAI: GPT-5.6 Luna Pro"` prefixed, on the same fetch — which would make
 * two siblings on one grid look inconsistent for no reason.
 *
 * The prefix is matched against the model's OWN maker rather than by shape.
 * Shape alone is not enough and a test pins why: `"Nemotron 3: The Reckoning"`
 * has a leading colon-terminated segment too, and a rule that only looked at
 * the punctuation renamed that model "The Reckoning". Both sides are folded
 * through `normalizeFamily`, so the catalogue's `"Z.ai"` matches the owner
 * `z-ai` and `"SpaceXAI"` matches `spacexai`.
 */
const stripMakerPrefix = (name: string, family: string): string => {
  const colon = name.indexOf(":");
  if (colon <= 0) return name;
  const rest = name.slice(colon + 1).trimStart();
  if (rest.length === 0) return name;
  return normalizeFamily(name.slice(0, colon)) === normalizeFamily(family)
    ? rest
    : name;
};

/**
 * Last resort when nothing has described the model yet: the key, spaced and
 * capitalised.
 *
 * Deliberately the FALLBACK and not the rule, because the key is a slug that
 * has already lost information the name needs. Measured over the 139 live rows:
 * version dots are gone (`alibaba-qwen3-5-flash` reads "Qwen3 5 Flash" where
 * the catalogue says "Qwen 3.5 Flash"), the owner is often duplicated
 * (`deepseek-deepseek-v4-flash`), and casing is unrecoverable ("Glm" for GLM,
 * "Gpt" for GPT). It beats showing a raw slug and nothing more.
 */
const nameFromKey = (key: string): string =>
  key
    .split("-")
    .map((word) =>
      word === "" ? word : word[0]?.toUpperCase() + word.slice(1),
    )
    .join(" ");

/**
 * Catalogue owner → our family name.
 *
 * The upstream catalogue names the LEGAL entity; we brand the MODEL LINE, and
 * the two diverge exactly where the line is better known than its owner. Only
 * the divergences are listed — anything absent already agrees with itself.
 */
const FAMILY_BY_CATALOGUE_OWNER: Record<string, KnownModelFamily> = {
  // Qwen is the model line; Alibaba is the company that ships it.
  alibaba: "qwen",
  // The catalogue's own spelling for xAI.
  spacexai: "xai",
  moonshot: "moonshotai",
  "z-ai": "zai",
  zhipu: "zai",
  "thinking-machines": "thinkingmachines",
  // The catalogues spell the company `mistralai`; we brand the line `mistral`.
  // Found by comparing all 22 curated profiles against their synthesised twins
  // on 2026-08-30: the three Mistral models were the only ones whose derived
  // family missed its branding and fell through to the neutral `other` icon.
  mistralai: "mistral",
};

/**
 * The family a catalogue owner belongs to, folded so `Moonshot AI`,
 * `moonshot-ai` and `moonshotai` all land together. Never throws and never
 * guesses: an owner we have no branding for keeps its own name and renders
 * through the `other` fallback.
 */
export const normalizeFamily = (owner: string): ModelFamily => {
  const folded = owner.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FAMILY_BY_CATALOGUE_OWNER[folded] ?? folded;
};

const FAMILY_BRANDING: Record<string, FamilyBranding> = {
  anthropic: { icon: "i-simple-icons-anthropic", brandColor: "#D97757" },
  // OpenAI's mark is monochrome black; `#412991` was the retired purple, which
  // no longer matches anything they publish. Near-black brands are inverted per
  // theme by the client (see `ModelsBrandMark`), so this stays the brand truth.
  openai: { icon: "i-simple-icons-openai", brandColor: "#000000" },
  google: {
    icon: "i-simple-icons-googlegemini",
    brandColor: "#1A73E8",
    brandGradient: { from: "#4796E3", to: "#9177C7" },
  },
  mistral: {
    icon: "i-simple-icons-mistralai",
    brandColor: "#FA520F",
    brandGradient: { from: "#FFD800", to: "#FA520F" },
  },
  minimax: { icon: "i-simple-icons-minimax", brandColor: "#E8484B" },
  // Moved off `hugeicons` on 2026-08-30: `simple-icons` carries both marks and
  // is the collection the frontend actually installs, so these now resolve from
  // our own server bundle instead of a runtime Iconify lookup.
  deepseek: { icon: "i-simple-icons-deepseek", brandColor: "#4D6BFE" },
  qwen: { icon: "i-simple-icons-qwen", brandColor: "#615CED" },
  // Makers the catalogue surfaces beyond the curated profiles. Every mark below
  // was checked against the live Iconify API before being written down — a name
  // that does not resolve renders as nothing at all, which is worse than the
  // neutral fallback it was meant to improve on.
  moonshotai: { icon: "i-simple-icons-moonshotai", brandColor: "#16141F" },
  nvidia: { icon: "i-simple-icons-nvidia", brandColor: "#76B900" },
  meta: { icon: "i-simple-icons-meta", brandColor: "#0081FB" },
  amazon: { icon: "i-simple-icons-amazon", brandColor: "#FF9900" },
  xiaomi: { icon: "i-simple-icons-xiaomi", brandColor: "#FF6900" },
  // Hunyuan is Tencent's model line, and this is the line's own mark.
  tencent: { icon: "i-simple-icons-tencenthy", brandColor: "#1E6FFF" },
  // The three no shipped collection carries, vendored under `app/assets/icons`
  // and served through the frontend's `brand` custom collection. Real marks,
  // monochrome so the colour above tints them.
  xai: { icon: "i-brand-xai", brandColor: "#111111" },
  zai: { icon: "i-brand-zai", brandColor: "#3859FF" },
  stepfun: { icon: "i-brand-stepfun", brandColor: "#005CFF" },
  // Thinking Machines publishes no mark any icon set has picked up, and
  // inventing one would be worse than a neutral shape.
  thinkingmachines: { icon: "i-lucide-brain-circuit", brandColor: "#0F9D8C" },
  other: { icon: "i-lucide-bot", brandColor: "#6B7280" },
};

/** The neutral mark, when even the `other` row is somehow missing. */
const OTHER_BRANDING: FamilyBranding = {
  icon: "i-lucide-bot",
  brandColor: "#6B7280",
};

/**
 * What a model is CALLED, from the catalogue that serves it.
 *
 * This was a hand-written table of 22 lines, which meant a model nobody had
 * typed a line for displayed its raw key — 117 of 139 live models rendered as
 * `zai-glm-5-3-flash` in the hub on 2026-08-30. The catalogues publish a name
 * for every model they serve, including every one the sync discovers, so the
 * table is gone and the name is read where it already exists.
 */
export const getModelDisplayName = (key: string): string => {
  const dynamic = getLiveStateSync(key)?.dynamicProfile;
  if (dynamic === null || dynamic === undefined) return nameFromKey(key);
  const named = stripMakerPrefix(dynamic.displayName, dynamic.family).trim();
  return named.length > 0 ? named : nameFromKey(key);
};

/**
 * Branding for a model family, falling back to the neutral mark.
 *
 * The fallback is load-bearing rather than defensive: families come from the
 * catalogue now, so a maker nobody has branded yet is an ordinary Tuesday
 * rather than a bug, and the card still has to render.
 */
export const getFamilyBranding = (family: ModelFamily): FamilyBranding =>
  FAMILY_BRANDING[family] ?? OTHER_BRANDING;
