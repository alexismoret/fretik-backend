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

/**
 * The UNIX user EVERY platform-initiated sandbox operation runs as — shell
 * commands and filesystem calls alike. Passed explicitly at each call site so
 * the choice is greppable and revertible in one line.
 *
 * WHY root. The Jupyter kernel behind `runCode` runs as root and the SDK
 * exposes no `user` on `createCodeContext`/`runCode`, so the `python` tool is
 * root whatever we put here — E2B's `code-interpreter` base does that on
 * purpose (`jupyter.service` carries no `User=`; its config sets
 * `allow_root = True`). Leaving `commands.run` on the template's `user`
 * (uid 1000) gave the two code tools DIFFERENT identities over ONE
 * `/workspace`: `python` wrote `root:root 0644` files that `bash` could not
 * rewrite, chmod, or feed to `skills/xlsx/scripts/recalc.py`, whose own
 * writability guard then refused to verify the workbook. Measured over
 * 2026-06-01→09-07: 79 permission failures across 42 conversations (3.9% of
 * every conversation that used the sandbox), 3-8 wasted turns each, and 15 of
 * those 42 shipped a spreadsheet whose formulas were never recalculated.
 *
 * Aligning UP grants the agent nothing it lacked. It already had root through
 * `python`, and the unprivileged account has PASSWORDLESS SUDO in the E2B
 * image anyway (`sudo -n true` succeeds — measured against the live template,
 * `user` is in group 27(sudo)). There is no privilege boundary here to
 * preserve; there was only a broken filesystem. Containment is the
 * per-conversation Firecracker microVM, never shared between conversations or
 * tenants, plus the egress allowlist — which is enforced OUTSIDE the guest
 * (`network-policy.ts`, passed to `Sandbox.create`), so no in-guest privilege
 * reaches it.
 *
 * REVERT: flip to `"user"` and redeploy — no template rebuild, because envd
 * resolves this per request. That is also the switch to throw the day E2B
 * accepts a `user` on `createCodeContext`: it would put the whole sandbox on
 * uid 1000, the only arrangement in which the platform-owned workspace dirs
 * could be enforced with mode bits instead of prose — and that only pays off
 * once the image's passwordless sudo goes too.
 */
export const SANDBOX_USER = "root";

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
