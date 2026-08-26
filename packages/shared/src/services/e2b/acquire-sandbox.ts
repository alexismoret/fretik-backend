import { Sandbox } from "@e2b/code-interpreter";
import { randomUUID } from "node:crypto";
import {
  E2B_ENVIRONMENT,
  E2B_TEMPLATE,
  SANDBOX_TIMEOUT_MS,
  assertE2BConfigured,
} from "./client";
import {
  buildSandboxNetworkPolicy,
  type NetworkPolicyOverrides,
} from "./network-policy";
import {
  SANDBOX_LOCK_TTL_S,
  acquireSandboxLock,
  clearSandboxFromRegistry,
  getSandboxIdFromRegistry,
  releaseSandboxLock,
  setSandboxIdInRegistry,
} from "./registry";
import type { SandboxLease } from "./types";

export interface AcquireSandboxOptions {
  /**
   * Extra domains to whitelist on top of the default allowlist. Used by
   * future workflow nodes that need to reach a specific third-party API
   * (e.g. `extraAllowOut: ["api.stripe.com"]`).
   */
  network?: NetworkPolicyOverrides;
}

/**
 * Polling parameters for the case where another instance is creating the
 * sandbox concurrently and we have to wait. `Sandbox.create` cold takes ~2-5 s
 * in practice, so the waiter normally wins on the first few ticks; the ceiling
 * matches `SANDBOX_LOCK_TTL_S` so a waiter never gives up while the holder
 * still legitimately owns the lock.
 */
const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_POLL_MAX_ITERATIONS = (SANDBOX_LOCK_TTL_S * 1000) / 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Sandbox.connect` resumes a paused sandbox AND sets its lease in the same
 * request (the connect body carries `timeout`, defaulting to the SDK's own
 * 5 min). Passing ours explicitly pins the value instead of inheriting a
 * default that could drift, and retires the separate `setTimeout` call this
 * used to make — a second HTTP round-trip that set what connect had just set.
 */
const connectWithLease = (sandboxId: string): Promise<Sandbox> =>
  Sandbox.connect(sandboxId, { timeoutMs: SANDBOX_TIMEOUT_MS });

const reconnectExisting = async (
  sandboxId: string,
  conversationId: string,
): Promise<SandboxLease> => {
  const sandbox = await connectWithLease(sandboxId);
  await setSandboxIdInRegistry(conversationId, sandboxId);
  return { sandboxId, conversationId, sandbox };
};

/**
 * Get the conversation's E2B sandbox, creating it on first call and
 * resuming it on subsequent calls. Always refreshes the sandbox-wide
 * timeout to `SANDBOX_TIMEOUT_MS` so each tool call gets a full window.
 *
 * Lifecycle: `lifecycle.onTimeout: 'pause'` + `autoResume: true` means
 * an idle sandbox (no API call for `SANDBOX_TIMEOUT_MS`) auto-pauses
 * on E2B's side and resumes transparently on the next API call. Acts
 * as a safety net if `releaseSandbox` (called from `onFinish`) is
 * skipped — paused sandboxes cost $0 instead of accumulating run time.
 *
 * Concurrency: the create branch is serialized via a Redis lock so
 * parallel `python`/`bash` calls in the same step don't double-spawn.
 * Fast paths (Redis cache hit, metadata fallback) bypass the lock.
 */
export const acquireSandbox = async (
  conversationId: string,
  options?: AcquireSandboxOptions,
): Promise<SandboxLease> => {
  assertE2BConfigured();
  // Fast path 1: Redis cache hit.
  const cachedId = await getSandboxIdFromRegistry(conversationId);
  if (cachedId) {
    try {
      const sandbox = await connectWithLease(cachedId);
      return { sandboxId: cachedId, conversationId, sandbox };
    } catch {
      // Sandbox cleaned up by E2B. Drop the stale Redis entry and fall
      // through to the metadata lookup.
      await clearSandboxFromRegistry(conversationId);
    }
  }

  // Fast path 2: existing sandbox tagged with our metadata (Redis
  // desync recovery, e.g. after AI server restart with TTL still live
  // on E2B side).
  const existing = Sandbox.list({
    query: { metadata: { conversationId, environment: E2B_ENVIRONMENT } },
  });
  if (existing.hasNext) {
    const sandboxes = await existing.nextItems();
    const first = sandboxes[0];
    if (first) {
      return reconnectExisting(first.sandboxId, conversationId);
    }
  }

  // Slow path: nothing exists, we'd need to create. Take the lock so a
  // concurrent caller doesn't race us.
  const lockToken = randomUUID();
  const gotLock = await acquireSandboxLock(conversationId, lockToken);
  if (!gotLock) {
    // Another acquire is creating right now. Poll Redis for the result.
    for (let i = 0; i < LOCK_POLL_MAX_ITERATIONS; i++) {
      await sleep(LOCK_POLL_INTERVAL_MS);
      const winnerId = await getSandboxIdFromRegistry(conversationId);
      if (winnerId) {
        return reconnectExisting(winnerId, conversationId);
      }
    }
    throw new Error(
      `Timeout waiting for concurrent acquireSandbox on ${conversationId}`,
    );
  }

  try {
    // Re-check under the lock — another caller may have populated Redis
    // (or E2B's metadata index) between our fast paths and the lock
    // acquire.
    const reCachedId = await getSandboxIdFromRegistry(conversationId);
    if (reCachedId) {
      return reconnectExisting(reCachedId, conversationId);
    }
    const reExisting = Sandbox.list({
      query: { metadata: { conversationId, environment: E2B_ENVIRONMENT } },
    });
    if (reExisting.hasNext) {
      const sandboxes = await reExisting.nextItems();
      const first = sandboxes[0];
      if (first) {
        return reconnectExisting(first.sandboxId, conversationId);
      }
    }

    const policy = buildSandboxNetworkPolicy(options?.network);
    const sbx = await Sandbox.create(E2B_TEMPLATE, {
      // `environment` gates the orphan sweep — see `E2B_ENVIRONMENT`.
      metadata: { conversationId, environment: E2B_ENVIRONMENT },
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause", autoResume: true },
      allowInternetAccess: true,
      network: { allowOut: policy.allowOut, denyOut: policy.denyOut },
      envs: {
        FRETIK_CONVERSATION_ID: conversationId,
        // Where the template pre-installs the Office skills' Node
        // libraries (see `template/build.ts`). Without this, a global
        // npm install is invisible to `require("pptxgenjs")` from
        // /workspace — Node resolves `node_modules` only by walking up
        // from the script's own directory, never the global prefix.
        NODE_PATH: "/opt/fretik/node/lib/node_modules",
      },
    });
    await setSandboxIdInRegistry(conversationId, sbx.sandboxId);
    return { sandboxId: sbx.sandboxId, conversationId, sandbox: sbx };
  } finally {
    await releaseSandboxLock(conversationId, lockToken);
  }
};
