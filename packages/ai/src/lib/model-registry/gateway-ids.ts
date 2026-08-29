import type { TransportId } from "@fretik/shared/model-registry/types";
import { MODEL_PROFILES } from "./profiles";

/**
 * Which model id each CURATED profile carries on each transport.
 *
 * This is a bridge for the profiles that predate the model engine, not the way
 * models are added. A model that needs no hand curation never appears here:
 * `model-admin add <creator/model>` writes a live-state row with a
 * catalogue-derived profile, and the nightly sync proposes new ones as
 * candidates by itself. Adding a model is a command, not a pull request.
 *
 * Nothing below is derived. The two catalogues disagree in every direction —
 * creator prefixes (`x-ai/` vs `spacexai/`, `z-ai/` vs `zai/`, `qwen/` vs
 * `alibaba/`), version spellings (`rerank-4-fast` vs `rerank-v4-fast`), preview
 * markers (`gemini-3.1-pro` vs `gemini-3.1-pro-preview`) — and a
 * plausible-looking transformation is precisely how a team ends up served a
 * different model. Every pair was checked against both live catalogues on
 * 2026-08-29.
 *
 * TWO PROFILES DELIBERATELY HAVE NO GATEWAY ENTRY, which is the clearest
 * argument for checking rather than deriving: the Gateway publishes
 * `mistral/mistral-small` and `mistral/ministral-8b`, which look like matches
 * for `mistral-small-2603` and `ministral-8b-2512` and are in fact the 2024
 * models — 32 000 tokens of context against 128 000, released 2024-09 and
 * 2024-10. Mapping them would have quietly downgraded a team by two model
 * generations. They stay on OpenRouter until the Gateway carries the dated
 * variants.
 */
const GATEWAY_MODEL_IDS: Readonly<Record<string, string>> = {
  // Identical id on both catalogues.
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "gemini-3.7-flash": "google/gemini-3.7-flash",
  "gemini-3.5-flash-lite": "google/gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  "gpt-5.4-nano": "openai/gpt-5.4-nano",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "gpt-oss-20b": "openai/gpt-oss-20b",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-haiku-4.5": "anthropic/claude-haiku-4.5",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro-0813",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash-0731",
  "minimax-m3": "minimax/minimax-m3",
  inkling: "thinkingmachines/inkling",

  // Different creator prefix.
  "glm-5.2": "zai/glm-5.2",
  "grok-4.5": "spacexai/grok-4.5",

  // Different version spelling.
  "mistral-medium-3.5": "mistral/mistral-medium-3.5",
};

/**
 * Profiles with no Gateway entry. Asserted by the registry test so that adding
 * one to the map without removing it here — or the reverse — fails CI rather
 * than silently changing which model a team gets.
 */
export const PROFILES_WITHOUT_GATEWAY_ID: readonly string[] = [
  "mistral-small-2603",
  "ministral-8b-2512",
];

/**
 * Embeddings and reranking do not go through the profile registry (they are
 * env-selected single-purpose models), and both stay on OpenRouter for now. The
 * embedding one has to preserve a 2 560-wide Matryoshka projection, and mixing
 * widths between corpus and query vectors is silent retrieval damage — so that
 * move needs its own dimension-equality check, not a catalogue lookup.
 */
export const GATEWAY_AUX_MODEL_IDS: Readonly<Record<string, string>> = {
  "qwen/qwen3-embedding-8b": "alibaba/qwen3-embedding-8b",
  "cohere/rerank-4-fast": "cohere/rerank-v4-fast",
};

/** The model id for a profile on a transport, or `undefined` when it has none. */
export const modelIdForTransport = (
  profileKey: string,
  transport: TransportId,
): string | undefined => {
  if (transport === "openrouter") return MODEL_PROFILES[profileKey]?.catalog.id;
  if (transport === "gateway") return GATEWAY_MODEL_IDS[profileKey];
  return undefined;
};

/** Every transport that can serve a profile. */
export const modelIdsForProfile = (
  profileKey: string,
): Partial<Record<TransportId, string>> => {
  const ids: Partial<Record<TransportId, string>> = {};
  const gateway = GATEWAY_MODEL_IDS[profileKey];
  if (gateway !== undefined) ids.gateway = gateway;
  const openrouter = MODEL_PROFILES[profileKey]?.catalog.id;
  if (openrouter !== undefined) ids.openrouter = openrouter;
  return ids;
};
