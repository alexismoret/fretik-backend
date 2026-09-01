/**
 * Model wiring façade — every model the service serves is resolved through the
 * registry (`./model-registry/`): profiles carry the facts (context, pricing,
 * modalities, parameters) and the assessments (grades, cache strategy, reasoning
 * envelope); role bindings carry the code defaults; the live-state table carries
 * the transport, the pool and the quarantines.
 *
 * Model env vars are GONE: changing a default model is a reviewed edit to
 * `model-registry/role-bindings.ts`, and per-team selection comes from the
 * database.
 *
 * **Everything here is a FUNCTION, not a constant.** These used to be
 * module-level values, resolved once at import. That was correct while their
 * inputs were compile-time constants and became wrong the moment routing gained
 * live state: an instance built at import keeps its transport and its provider
 * pool forever, so a quarantine written at three in the morning would apply to
 * every caller except the ones holding one of these. The registry memoizes
 * behind each call and drops the memo on any change, so calling per use costs a
 * map lookup and is always current.
 *
 * The same trap has been sprung here before, for a different reason: the page
 * builder was resolved at module load and every page a team generated was
 * written by the code default rather than by the model they had chosen.
 */
import { getProfileForRole, resolveModel } from "./model-registry/resolve";

export { openrouterClient as openrouter } from "./model-registry/transports/openrouter";

/** Primary chat model — the registry's `chat` role (flagship tier). */
export const chatModel = () => resolveModel("chat").model;

/**
 * Fallback model used when the primary errors out. Wrapped at the SDK level in
 * `agents/shared/agent-builder.ts`.
 */
export const fallbackChatModel = () => resolveModel("chat-fallback").model;

/**
 * Pre-extraction models (primary + fallback). Consumed by
 * `services/pre-extract/extract.ts` and `handlers/field-definitions.ts` via
 * `generateText()`.
 */
export const preextractModel = () => resolveModel("pre-extract").model;
export const preextractFallbackModel = () =>
  resolveModel("pre-extract-fallback").model;

/** Exposed for log/diagnostic purposes. */
export const preextractModelIds = () => ({
  primary: getProfileForRole("pre-extract").catalog.id,
  fallback: getProfileForRole("pre-extract-fallback").catalog.id,
});

/**
 * Active Memory recall model — the registry's `active-memory` role. Runs the
 * pre-reply judgment step that decides which persistent memories are relevant
 * for the current turn: judgment-on-context (no factual recall, no tool
 * chaining), so a small, fast, cheap model is sufficient.
 */
export const activeMemoryModel = () => resolveModel("active-memory").model;

export const activeMemoryModelId = () =>
  getProfileForRole("active-memory").catalog.id;

/**
 * Sub-agent "cheap" model used by the `dispatchAgent` tool when the caller picks
 * `model: "cheap"` — the registry's `dispatch-cheap` role. The "primary" path of
 * `dispatchAgent` reuses the chat model directly.
 */
export const dispatchAgentCheapModel = () =>
  resolveModel("dispatch-cheap").model;

export const dispatchAgentCheapModelId = () =>
  getProfileForRole("dispatch-cheap").catalog.id;
