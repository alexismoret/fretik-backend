/**
 * Internal E2B configuration helpers. Shared between every operation in
 * `services/e2b/*` so we read the env once and fail fast at boot when
 * keys are missing.
 */

const E2B_API_KEY = process.env.E2B_API_KEY;
if (!E2B_API_KEY && process.env.NODE_ENV === "production") {
  throw "Missing env var E2B_API_KEY";
}

export const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "fretik-sandbox";

/** Sandbox-wide hard cap. Reset on every reconnect. */
export const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Redis TTL for the `conversationId → sandboxId` mapping. Refreshed on
 * every `acquireSandbox`. Doubles as the staleness horizon for the
 * orphan reclaim: any sandbox whose conversation has not touched Redis
 * for >TTL is considered abandoned and is killed by `reclaimOrphan-
 * Sandboxes`. 1h gives the user a comfortable window to come back from
 * a coffee/lunch break and resume the same sandbox state, while
 * preventing paused sandboxes from accumulating against the 20-
 * concurrent quota.
 */
export const SANDBOX_REGISTRY_TTL_S = 60 * 60;

/**
 * Sandbox.create options that never change between conversations:
 * deny-all egress baseline, the conversation metadata key, the
 * timeoutMs default. Per-call options (network overrides, env injection)
 * layer on top of this in `acquire-sandbox.ts`.
 */
export const sandboxRegistryKey = (conversationId: string): string =>
  `e2b:sandbox:${conversationId}`;
