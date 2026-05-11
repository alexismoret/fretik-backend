import { Sandbox } from "@e2b/code-interpreter";
import { redis } from "../../lib/redis";
import { reclaimOrphanSandboxes } from "./reclaim-orphans";
import { clearSandboxFromRegistry, getSandboxIdFromRegistry } from "./registry";

const RECLAIM_THROTTLE_KEY = "e2b:reclaim:throttle";
const RECLAIM_THROTTLE_TTL_S = 30 * 60;

/**
 * Pause the conversation's sandbox to drop billing to $0 between tool
 * calls. State (filesystem, memory, processes) is preserved on E2B side
 * and the next `acquireSandbox` resumes implicitly via `Sandbox.connect`.
 *
 * Best-effort: if the sandbox has already been destroyed by E2B (max
 * lifetime), we just clear the Redis entry and move on. Never throws.
 *
 * Doubles as the steady-state reclaim trigger: at most every 30 min
 * (across all AI server replicas), the first releaser also runs
 * `reclaimOrphanSandboxes` async. Multi-instance safe via Redis SETNX.
 * Fire-and-forget — never blocks the release.
 */
export const releaseSandbox = async (conversationId: string): Promise<void> => {
  const sandboxId = await getSandboxIdFromRegistry(conversationId);
  if (!sandboxId) return;
  try {
    await Sandbox.pause(sandboxId);
  } catch (err) {
    console.warn(
      `[e2b:release] pause failed for sandbox ${sandboxId} (conv ${conversationId}):`,
      err instanceof Error ? err.message : err,
    );
    await clearSandboxFromRegistry(conversationId);
  }

  const got = await redis.set(
    RECLAIM_THROTTLE_KEY,
    "1",
    "EX",
    RECLAIM_THROTTLE_TTL_S,
    "NX",
  );
  if (got === "OK") {
    void reclaimOrphanSandboxes().catch((err: unknown) => {
      console.warn(
        "[e2b:reclaim] background sweep failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }
};
