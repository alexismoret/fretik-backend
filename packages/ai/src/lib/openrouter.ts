/**
 * Model wiring façade — every model the service serves is resolved
 * through the registry (`./model-registry/`): profiles carry the
 * facts (context, pricing, modalities, parameters — synced against
 * the OpenRouter API) and the assessments (grades, cache strategy,
 * reasoning level); role bindings carry the code defaults.
 *
 * Model env vars are GONE: changing a default model is a reviewed
 * edit to `model-registry/profiles.ts`, gated by the eval harness.
 * Per-team / per-conversation overrides arrive with chantier C8 (DB).
 *
 * This module keeps the historical export surface so call sites
 * (`agents/chatbot/index.ts`, `handlers/field-definitions.ts`,
 * `services/*`) stay unchanged.
 */
import {
  getProfileForRole,
  openrouter,
  resolveModel,
} from "./model-registry/resolve";

export { openrouter };

/** Primary chat model — the registry's `chat` role (flagship tier). */
export const chatModel = resolveModel("chat").model;

/**
 * Fallback model used when the primary errors out. Wrapped at the SDK
 * level in `agents/shared/agent-builder.ts`.
 */
export const fallbackChatModel = resolveModel("chat-fallback").model;

/**
 * Pre-extraction models (primary + fallback). Consumed by
 * `services/pre-extract/extract.ts` and
 * `handlers/field-definitions.ts` via `generateText()`.
 */
export const preextractModel = resolveModel("pre-extract").model;
export const preextractFallbackModel = resolveModel(
  "pre-extract-fallback",
).model;

/** Exposed for log/diagnostic purposes. */
export const PREEXTRACT_MODEL_IDS = {
  primary: getProfileForRole("pre-extract").catalog.id,
  fallback: getProfileForRole("pre-extract-fallback").catalog.id,
} as const;

/**
 * Active Memory recall model — the registry's `active-memory` role.
 * Runs the pre-reply judgment step that decides which persistent
 * memories are relevant for the current turn: judgment-on-context
 * (no factual recall, no tool chaining), so a small, fast, cheap
 * model is sufficient.
 */
export const activeMemoryModel = resolveModel("active-memory").model;

export const ACTIVE_MEMORY_MODEL_ID =
  getProfileForRole("active-memory").catalog.id;

/**
 * Sub-agent "cheap" model used by the `dispatchAgent` tool when the
 * caller picks `model: "cheap"` — the registry's `dispatch-cheap`
 * role. The "primary" path of `dispatchAgent` reuses `chatModel`
 * directly (same model as the main agent).
 */
export const dispatchAgentCheapModel = resolveModel("dispatch-cheap").model;

export const DISPATCH_AGENT_CHEAP_MODEL_ID =
  getProfileForRole("dispatch-cheap").catalog.id;
