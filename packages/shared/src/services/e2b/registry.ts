import { redis } from "../../lib/redis";
import { SANDBOX_REGISTRY_TTL_S, sandboxRegistryKey } from "./client";

/**
 * Internal Redis-backed map of `conversationId → sandboxId`. Used by
 * `acquireSandbox` to skip the `Sandbox.list({ metadataFilter })`
 * round-trip on consecutive tool calls. E2B remains the source of
 * truth — a Redis miss falls back to listing by metadata, and a stale
 * value is detected on connect failure.
 *
 * Also exposes a per-conversation lock (`e2b:sandbox:{convId}:lock`)
 * used by `acquireSandbox` to serialize the create branch. Token-
 * scoped release via Lua so a process can never accidentally drop a
 * lock taken by someone else (e.g. after a slow Sandbox.create that
 * exceeded the lock TTL).
 */

export const getSandboxIdFromRegistry = async (
  conversationId: string,
): Promise<string | null> => redis.get(sandboxRegistryKey(conversationId));

export const setSandboxIdInRegistry = async (
  conversationId: string,
  sandboxId: string,
): Promise<void> => {
  await redis.set(
    sandboxRegistryKey(conversationId),
    sandboxId,
    "EX",
    SANDBOX_REGISTRY_TTL_S,
  );
};

export const clearSandboxFromRegistry = async (
  conversationId: string,
): Promise<void> => {
  await redis.del(sandboxRegistryKey(conversationId));
};

const SANDBOX_LOCK_TTL_S = 30;
const sandboxLockKey = (conversationId: string): string =>
  `${sandboxRegistryKey(conversationId)}:lock`;

const SANDBOX_LOCK_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Try to take the per-conversation create-lock. Returns `true` if we
 * own it for the next 30s, `false` if another caller holds it.
 */
export const acquireSandboxLock = async (
  conversationId: string,
  token: string,
): Promise<boolean> => {
  const result = await redis.set(
    sandboxLockKey(conversationId),
    token,
    "EX",
    SANDBOX_LOCK_TTL_S,
    "NX",
  );
  return result === "OK";
};

/**
 * Release the per-conversation create-lock if and only if we still own
 * it (token match). Idempotent on TTL expiry — does nothing if the
 * lock has already been auto-released.
 */
export const releaseSandboxLock = async (
  conversationId: string,
  token: string,
): Promise<void> => {
  await redis.eval(
    SANDBOX_LOCK_RELEASE_LUA,
    1,
    sandboxLockKey(conversationId),
    token,
  );
};

// ============================================================ //
// BOOTSTRAP LOCK — keyed on sandboxId, not conversationId        //
// ============================================================ //

/**
 * Bootstrap of a sandbox's `/workspace` (creating dirs, pushing
 * bundled skills, restoring backed-up files from S3) is keyed on the
 * **sandboxId**, not the conversationId, because a single sandbox
 * lives across exactly one conversation but can be created by any
 * replica when the previous one expired. Two replicas concurrently
 * receiving the first message of a resumed conversation would both
 * try to bootstrap — the lock makes one win and the other wait.
 *
 * 60s TTL covers the worst-case bootstrap (skills push + several
 * megabytes of S3 restore in parallel). On TTL expiry the lock
 * auto-releases so a wedged replica can't stall every future turn.
 */
const SANDBOX_BOOTSTRAP_LOCK_TTL_S = 60;

const sandboxBootstrapLockKey = (sandboxId: string): string =>
  `e2b:sandbox-bootstrap:${sandboxId}:lock`;

export const acquireSandboxBootstrapLock = async (
  sandboxId: string,
  token: string,
): Promise<boolean> => {
  const result = await redis.set(
    sandboxBootstrapLockKey(sandboxId),
    token,
    "EX",
    SANDBOX_BOOTSTRAP_LOCK_TTL_S,
    "NX",
  );
  return result === "OK";
};

export const releaseSandboxBootstrapLock = async (
  sandboxId: string,
  token: string,
): Promise<void> => {
  await redis.eval(
    SANDBOX_LOCK_RELEASE_LUA,
    1,
    sandboxBootstrapLockKey(sandboxId),
    token,
  );
};
