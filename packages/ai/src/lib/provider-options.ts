import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

/**
 * Merge one patch into a call's `providerOptions` without losing what the
 * caller already put there.
 *
 * ## Why this exists
 *
 * AI SDK v7's `prepareCall` REPLACES the call settings wholesale
 * (`preparedCallArgs = (await prepareCall(baseCallArgs)) ?? baseCallArgs`), so
 * an agent that wants to add one field has to spread the base itself — and a
 * spread of `providerOptions` replaces the whole `openrouter` namespace, not
 * just the key it meant to set. The symptom is silent: the handler's
 * `file-parser` plugin and the delegate's reasoning level both live under
 * `openrouter`, and whichever is written second erases the other.
 *
 * That is why `agent-builder.ts` used to gate its reasoning injection on
 * `baseCallArgs.providerOptions === undefined` — not because a caller's
 * providerOptions meant "do not set reasoning", but because the code had no
 * way to add a key without destroying its neighbours.
 *
 * ## Exactly two levels, on purpose
 *
 * Namespace (`openrouter`, `gateway`, …), then key inside it. `patch` wins per
 * key. **Nothing deeper.**
 *
 * A recursive merge would be wrong, not merely excessive. `reasoning` is a
 * discriminated union — `{ enabled, max_tokens }` or `{ enabled, effort }` —
 * and merging `{ effort: "high" }` into `{ max_tokens: 8000 }` yields an object
 * carrying both, which OpenRouter rejects. A value is replaced whole or left
 * alone; it is never blended with the one underneath it.
 */
export const mergeProviderOptions = (
  base: SharedV4ProviderOptions | undefined,
  patch: SharedV4ProviderOptions,
): SharedV4ProviderOptions => {
  const merged: SharedV4ProviderOptions = { ...base };
  for (const [namespace, values] of Object.entries(patch)) {
    merged[namespace] = { ...merged[namespace], ...values };
  }
  return merged;
};
