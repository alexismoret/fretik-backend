/**
 * STATIC user-facing branding for model profiles (chantier C8).
 *
 * Kept OUT of `profiles.ts` on purpose: `profiles.ts` is the agent-/
 * engineering registry (gate facts, catalog mirror), this file is pure
 * presentation. It holds ONLY branding that never changes from an API:
 *
 * - `MODEL_DISPLAY` — per profile key: the brand `displayName` (e.g.
 *   "MiniMax M3"). Quantitative metrics (intelligence, speed, price) are
 *   NOT here — they come live from `services/model-metrics` (Artificial
 *   Analysis + OpenRouter).
 * - `FAMILY_BRANDING` — per family: simple-icons mark + brand colour /
 *   optional gradient (the icons are monochrome, so the colour lives here).
 *   Brand colour, not model colour — every model of a family shares it.
 *
 * Defensive: `getModelDisplay` falls back for any key absent here, so gating
 * a new profile in `profiles.ts` never breaks rendering.
 */

import type { KnownModelFamily, ModelFamily } from "./types";

export interface FamilyBranding {
  /** Iconify name — simple-icons brand mark (verified) or a lucide fallback. */
  icon: string;
  /** Brand colour hex — applied to the (monochrome) icon + card accents. */
  brandColor: string;
  /** Optional logo-faithful gradient for the card accent. */
  brandGradient?: { from: string; to: string };
}

/** Exported so `models:admin audit` can name entries that outlived their model. */
export const MODEL_DISPLAY_NAME: Record<string, string> = {
  // Anthropic
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  // OpenAI
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.4-nano": "GPT-5.4 nano",
  "gpt-oss-120b": "GPT-OSS 120B",
  "gpt-oss-20b": "GPT-OSS 20B",
  // Google
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  // Mistral
  "mistral-medium-3.5": "Mistral Medium 3.5",
  "mistral-small-2603": "Mistral Small",
  "ministral-8b-2512": "Ministral 8B",
  // MiniMax
  "minimax-m3": "MiniMax M3",
  // DeepSeek
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  // Z.ai (GLM)
  "glm-5.2": "GLM-5.2",
  // xAI
  "grok-4.5": "Grok 4.5",
  // Thinking Machines
  inkling: "Inkling",
};

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
  openai: { icon: "i-simple-icons-openai", brandColor: "#412991" },
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

/** Brand display name for a profile key (falls back to the key itself). */
export const getModelDisplayName = (key: string): string =>
  MODEL_DISPLAY_NAME[key] ?? key;

/**
 * Branding for a model family, falling back to the neutral mark.
 *
 * The fallback is load-bearing rather than defensive: families come from the
 * catalogue now, so a maker nobody has branded yet is an ordinary Tuesday
 * rather than a bug, and the card still has to render.
 */
export const getFamilyBranding = (family: ModelFamily): FamilyBranding =>
  FAMILY_BRANDING[family] ?? OTHER_BRANDING;
