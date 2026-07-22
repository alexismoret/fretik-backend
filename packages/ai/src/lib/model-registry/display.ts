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

import type { ModelFamily } from "./types";

export interface FamilyBranding {
  /** Iconify name — simple-icons brand mark (verified) or a lucide fallback. */
  icon: string;
  /** Brand colour hex — applied to the (monochrome) icon + card accents. */
  brandColor: string;
  /** Optional logo-faithful gradient for the card accent. */
  brandGradient?: { from: string; to: string };
}

const MODEL_DISPLAY_NAME: Record<string, string> = {
  // Anthropic
  "claude-opus-4.8": "Claude Opus 4.8",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  // OpenAI
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4-nano": "GPT-5.4 nano",
  "gpt-oss-120b": "GPT-OSS 120B",
  "gpt-oss-20b": "GPT-OSS 20B",
  "gpt-4o-mini": "GPT-4o mini",
  // Google
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
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
  "glm-5.1": "GLM-5.1",
  "glm-4.7": "GLM-4.7",
};

const FAMILY_BRANDING: Record<ModelFamily, FamilyBranding> = {
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
  // MiniMax has no simple-icons mark — generic fallback + brand-ish colour.
  minimax: { icon: "i-simple-icons-minimax", brandColor: "#E8484B" },
  deepseek: { icon: "i-hugeicons-deepseek", brandColor: "#4D6BFE" },
  qwen: { icon: "i-hugeicons-qwen", brandColor: "#615CED" },
  // Z.ai / Zhipu (GLM) has no simple-icons mark — generic fallback.
  zai: { icon: "i-lucide-hexagon", brandColor: "#3859FF" },
  other: { icon: "i-lucide-bot", brandColor: "#6B7280" },
};

/** Brand display name for a profile key (falls back to the key itself). */
export const getModelDisplayName = (key: string): string =>
  MODEL_DISPLAY_NAME[key] ?? key;

/** Branding (icon + colour/gradient) for a model family. */
export const getFamilyBranding = (family: ModelFamily): FamilyBranding =>
  FAMILY_BRANDING[family];
