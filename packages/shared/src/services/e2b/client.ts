/**
 * Internal E2B configuration helpers. Shared between every operation in
 * `services/e2b/*`. The key check is deferred to `acquireSandbox` — the
 * only path that *requires* E2B — so consumers that merely import e2b
 * for best-effort cleanup (`killSandbox` from API's conversation
 * delete) don't crash at boot when the env var is absent.
 */

export const assertE2BConfigured = (): void => {
  if (!process.env.E2B_API_KEY && process.env.NODE_ENV === "production") {
    // An `Error`, not a bare string: every `err instanceof Error` guard on the
    // way out (tool error mapping, the Hono error handler) misses a string and
    // reports "Unknown error" with no stack.
    throw new Error("Missing env var E2B_API_KEY");
  }
};

/**
 * Which deployment a sandbox belongs to, stamped into `Sandbox.create`
 * metadata and required to match before `reclaimOrphanSandboxes` kills
 * anything.
 *
 * Without it the only ownership signal was "this sandbox carries a
 * conversationId", and the orphan sweep kills every such sandbox whose id is
 * absent from the LOCAL Redis — so a dev boot sharing one `E2B_API_KEY` with
 * production would kill production's sandboxes mid-turn.
 *
 * `NODE_ENV` is deliberately not in the chain: dev `.env` files here set it to
 * `production`, which is exactly the collision this guards against. When both
 * deployments resolve to the same tag the behaviour is simply what it was
 * before — never worse.
 */
export const E2B_ENVIRONMENT =
  process.env.FRETIK_ENV ??
  process.env.LANGFUSE_TRACING_ENVIRONMENT ??
  "unknown";

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

/** Redis key holding the conversation's current sandbox id. */
export const sandboxRegistryKey = (conversationId: string): string =>
  `e2b:sandbox:${conversationId}`;
