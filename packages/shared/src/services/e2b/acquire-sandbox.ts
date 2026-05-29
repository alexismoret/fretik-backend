import { Sandbox } from "@e2b/code-interpreter";
import { randomUUID } from "node:crypto";
import {
  E2B_TEMPLATE,
  SANDBOX_TIMEOUT_MS,
  assertE2BConfigured,
} from "./client";
import {
  buildSandboxNetworkPolicy,
  type NetworkPolicyOverrides,
} from "./network-policy";
import {
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
 * Polling parameters for the case where another instance is creating
 * the sandbox concurrently and we have to wait. 200ms × 75 = 15s
 * ceiling — `Sandbox.create` cold takes ~2-5s in practice, so the
 * waiter wins comfortably.
 */
const LOCK_POLL_INTERVAL_MS = 200;
const LOCK_POLL_MAX_ITERATIONS = 75;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const reconnectExisting = async (
  sandboxId: string,
  conversationId: string,
): Promise<SandboxLease> => {
  const sbx = await Sandbox.connect(sandboxId);
  await sbx.setTimeout(SANDBOX_TIMEOUT_MS);
  await setSandboxIdInRegistry(conversationId, sandboxId);
  return { sandboxId, conversationId };
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
      const sbx = await Sandbox.connect(cachedId);
      await sbx.setTimeout(SANDBOX_TIMEOUT_MS);
      return { sandboxId: cachedId, conversationId };
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
    query: { metadata: { conversationId } },
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
      query: { metadata: { conversationId } },
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
      metadata: { conversationId },
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause", autoResume: true },
      allowInternetAccess: true,
      network: { allowOut: policy.allowOut, denyOut: policy.denyOut },
      envs: { FRETIK_CONVERSATION_ID: conversationId },
    });
    await setSandboxIdInRegistry(conversationId, sbx.sandboxId);
    return { sandboxId: sbx.sandboxId, conversationId };
  } finally {
    await releaseSandboxLock(conversationId, lockToken);
  }
};
