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

/**
 * Batch read for the orphan sweep: one MGET instead of one GET per sandbox.
 * Returns entries positionally, `null` where the conversation has no live
 * mapping.
 */
export const getSandboxIdsFromRegistry = async (
  conversationIds: readonly string[],
): Promise<(string | null)[]> => {
  if (conversationIds.length === 0) return [];
  return redis.mget(conversationIds.map(sandboxRegistryKey));
};

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

// ============================================================ //
// ATTACHMENT GENERATION — lazy sandbox hydration                //
// ============================================================ //

/**
 * Monotonic per-conversation counter, bumped every time a user file is
 * attached. Attachments are written to S3 only (never eagerly pushed to
 * the sandbox — `read`/extraction work straight off S3, and only
 * `python`/`bash` need the workspace). The counter lets
 * `ensureSandboxReady` detect that new files landed and restore them
 * from S3 the next time a sandbox tool actually runs, instead of paying
 * a sandbox round-trip at attach time. Shares the registry TTL — moot
 * once the conversation's sandbox is gone.
 */
const attachmentGenerationKey = (conversationId: string): string =>
  `e2b:attach-gen:${conversationId}`;

export const bumpAttachmentGeneration = async (
  conversationId: string,
): Promise<number> => {
  const key = attachmentGenerationKey(conversationId);
  const next = await redis.incr(key);
  await redis.expire(key, SANDBOX_REGISTRY_TTL_S);
  return next;
};

export const getAttachmentGeneration = async (
  conversationId: string,
): Promise<number> => {
  const raw = await redis.get(attachmentGenerationKey(conversationId));
  return raw ? Number.parseInt(raw, 10) : 0;
};

/**
 * Create-lock TTL. Must be >= the window a waiter is willing to poll for
 * (`LOCK_POLL_*` in `acquire-sandbox.ts`), or the holder's lock expires while
 * it is still creating and a second caller spawns a duplicate sandbox — which
 * `acquireSandbox` then silently orphans, since it only ever reads
 * `sandboxes[0]`. A cold `Sandbox.create` is 2-5 s in practice; 60 s is the
 * headroom, and it is also the longest a crashed holder can block a single
 * conversation's first code call.
 */
export const SANDBOX_LOCK_TTL_S = 60;
const sandboxLockKey = (conversationId: string): string =>
  `${sandboxRegistryKey(conversationId)}:lock`;

const SANDBOX_LOCK_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Try to take the per-conversation create-lock. Returns `true` if we own it
 * for the next `SANDBOX_LOCK_TTL_S`, `false` if another caller holds it.
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
